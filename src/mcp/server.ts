import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { MERCHANT_NAME } from '../config.js';
import type { StorefrontDeps } from '../deps.js';
import { registerAgent, requireRegisteredAgent } from '../domain/agents.js';
import { findPublishedVariant, listPublishedVariants } from '../domain/catalog.js';
import { checkout } from '../domain/checkout.js';
import { findOrderById, toOrderStatusView } from '../domain/orders.js';
import { Refusal, ValidationError } from '../domain/refusal.js';

/**
 * The MCP face of the storefront core.
 *
 * Transport is authless by decision (PLAN §3, §5.2): identity, authorization
 * and spend control live *in* the protocol — not in a header. T3 makes that
 * concrete: `register_agent` mints an Agent (ADR-0001), and the commerce tools
 * demand its `agentToken` as an ordinary tool argument, refusing
 * `UNREGISTERED_AGENT` without one. `get_product` stays token-free on purpose —
 * a shop window is public; registration gates transacting, not looking.
 *
 * A fresh `McpServer` is built per HTTP request (stateless Streamable HTTP), so
 * this function must stay cheap and hold no per-connection state — which is
 * also why the token rides on every call rather than in a session.
 */

function textResult(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

/**
 * Failures reach the buyer agent as `isError` results carrying a structured
 * body, never as prose. The two categories stay visibly distinct on the wire —
 * a Refusal has `recoverable`, a validation error does not — so an LLM buyer
 * can branch on which kind of "no" it received (CONTEXT.md → Failure vocabulary).
 */
function refusalResult(refusal: Refusal) {
  return {
    isError: true,
    content: [
      { type: 'text' as const, text: JSON.stringify({ refusal: refusal.toPayload() }, null, 2) },
    ],
  };
}

function validationResult(error: ValidationError) {
  return {
    isError: true,
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ validationError: error.toPayload() }, null, 2),
      },
    ],
  };
}

export function createMcpServer(deps: StorefrontDeps): McpServer {
  const server = new McpServer(
    { name: 'agent-store', version: '0.1.0' },
    {
      instructions:
        `Storefront for ${MERCHANT_NAME}. Prices are integer paise (INR). ` +
        `Call get_product to see what is for sale. Before buying, call register_agent ` +
        `once, declaring your Cap (spend ceiling, integer paise): it returns the ` +
        `agentToken that checkout and get_order_status require on every call. ` +
        `checkout does not move money: it returns a Razorpay-hosted payment link ` +
        `that the human must approve — that approval is the only way money moves. ` +
        `Poll get_order_status afterwards to see the order flip to paid.`,
    },
  );

  server.registerTool(
    'get_product',
    {
      title: 'Get product',
      description:
        'List what this merchant currently has published for sale. Returns Variants — ' +
        'the sellable unit — with their variantId, price in integer paise, and stock.',
      inputSchema: {},
    },
    async () => {
      const catalogue = await listPublishedVariants(deps.db, deps.merchantId);
      return textResult({
        merchant: MERCHANT_NAME,
        note: 'All prices are integer paise. 49900 paise = ₹499.00.',
        variants: catalogue,
      });
    },
  );

  server.registerTool(
    'register_agent',
    {
      title: 'Register agent',
      description:
        'Register as an Agent with this merchant and declare your Cap — the maximum total ' +
        'you authorize spending here, in integer paise (e.g. 500000 = ₹5,000.00). Returns ' +
        'an agentToken; pass it on every checkout and get_order_status call. The merchant ' +
        'holds your Ed25519 keypair in custody and signs on your behalf. Registering again ' +
        'creates a brand-new Agent with a fresh Cap — the Cap of an existing registration ' +
        'can never be changed.',
      inputSchema: {
        capPaise: z
          .number()
          .describe(
            'Your spend ceiling with this merchant, as a positive integer number of paise. ' +
              'Not rupees, no decimals: 500000 means ₹5,000.00.',
          ),
      },
    },
    async ({ capPaise }) => {
      try {
        const registration = await registerAgent(deps.db, deps.merchantId, { capPaise });
        return textResult({
          ...registration,
          note:
            'Keep agentToken for every subsequent call. Your private key stays in merchant ' +
            'custody and is never returned. To change the Cap, register again: that mints ' +
            'a new Agent with the new Cap.',
        });
      } catch (error) {
        if (error instanceof Refusal) return refusalResult(error);
        if (error instanceof ValidationError) return validationResult(error);
        throw error;
      }
    },
  );

  server.registerTool(
    'checkout',
    {
      title: 'Checkout',
      description:
        'Create an order and return a Razorpay-hosted payment link for the human to approve. ' +
        'No money moves until the human approves that link. Requires the agentToken from ' +
        "register_agent. Omit variantId to buy the merchant's only published Variant.",
      inputSchema: {
        agentToken: z
          .string()
          .optional()
          .describe('Your agentToken from register_agent. Calls without a valid one refuse.'),
        variantId: z
          .string()
          .optional()
          .describe('Variant to buy, from get_product. Omit if the merchant sells only one.'),
        quantity: z.number().int().min(1).max(10).default(1).describe('How many units to buy.'),
      },
    },
    async ({ agentToken, variantId, quantity }) => {
      try {
        // The trust gate runs first — an unregistered agent is refused before
        // any Order exists and before the gateway is ever touched.
        await requireRegisteredAgent(deps.db, deps.merchantId, agentToken, 'checkout');
        const result = await checkout(deps, {
          merchantId: deps.merchantId,
          variantId,
          quantity: quantity ?? 1,
        });
        return textResult({
          orderId: result.orderId,
          status: result.status,
          total: result.total,
          quantity: result.quantity,
          product: result.variant.productTitle,
          variantId: result.variant.variantId,
          paymentLinkUrl: result.paymentLinkUrl,
          gatewayPaymentLinkId: result.gatewayPaymentLinkId,
          nextStep:
            'Give paymentLinkUrl to your human and ask them to approve it. ' +
            'In Razorpay test mode the UPI id success@razorpay completes the payment. ' +
            `Then call get_order_status with orderId ${result.orderId}.`,
          auditUrl: `${deps.publicBaseUrl}/audit/${result.orderId}`,
        });
      } catch (error) {
        if (error instanceof Refusal) return refusalResult(error);
        if (error instanceof ValidationError) return validationResult(error);
        throw error;
      }
    },
  );

  server.registerTool(
    'get_order_status',
    {
      title: 'Get order status',
      description:
        'Look up one order by the orderId returned from checkout. `paid` means the human ' +
        'approved the payment link and the gateway webhook confirmed it. Requires the ' +
        'agentToken from register_agent.',
      inputSchema: {
        agentToken: z
          .string()
          .optional()
          .describe('Your agentToken from register_agent. Calls without a valid one refuse.'),
        orderId: z.string().describe('The orderId returned by checkout (starts with ord_).'),
      },
    },
    async ({ agentToken, orderId }) => {
      try {
        await requireRegisteredAgent(deps.db, deps.merchantId, agentToken, 'get_order_status');
        const row = await findOrderById(deps.db, deps.merchantId, orderId);
        if (row === null) {
          return validationResult(
            new ValidationError('ORDER_NOT_FOUND', `No order with id ${orderId}`),
          );
        }
        const variant = await findPublishedVariant(deps.db, deps.merchantId, row.variantId);
        return textResult({
          ...toOrderStatusView(row),
          product: variant?.productTitle ?? null,
          auditUrl: `${deps.publicBaseUrl}/audit/${row.id}`,
        });
      } catch (error) {
        if (error instanceof Refusal) return refusalResult(error);
        if (error instanceof ValidationError) return validationResult(error);
        throw error;
      }
    },
  );

  return server;
}
