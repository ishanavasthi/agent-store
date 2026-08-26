import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { MERCHANT_NAME } from '../config.js';
import type { StorefrontDeps } from '../deps.js';
import { registerAgent, requireRegisteredAgent } from '../domain/agents.js';
import { findPublishedVariant, listPublishedVariants } from '../domain/catalog.js';
import { createCart, declareIntent } from '../domain/mandateFlow.js';
import { findOrderById, listOrderItems, toOrderStatusView } from '../domain/orders.js';
import { findOrderReceipt } from '../domain/receipts.js';
import { submitPayment } from '../domain/submitPayment.js';
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

/**
 * The one place domain errors become wire results. Every tool that can refuse
 * or reject wraps its handler here, so a new tool (T4's next one included)
 * inherits the mapping instead of copying the catch.
 */
function withToolErrors<Args extends unknown[], Result>(
  handler: (...args: Args) => Promise<Result>,
) {
  return async (...args: Args) => {
    try {
      return await handler(...args);
    } catch (error) {
      if (error instanceof Refusal) return refusalResult(error);
      if (error instanceof ValidationError) return validationResult(error);
      throw error;
    }
  };
}

export function createMcpServer(deps: StorefrontDeps): McpServer {
  const server = new McpServer(
    { name: 'agent-store', version: '0.1.0' },
    {
      instructions:
        `Storefront for ${MERCHANT_NAME}. All prices are integer paise (INR): ` +
        `129900 means ₹1,299.00 — never send rupees or decimals. Buying is a ` +
        `signed mandate chain, one tool per step, in order: (1) get_product to ` +
        `see the Variants for sale. (2) register_agent once, declaring your Cap ` +
        `(spend ceiling, integer paise) — it returns the agentToken every later ` +
        `call requires. (3) declare_intent with what you want and your budgetPaise ` +
        `for this purchase — returns an intentHash. (4) create_cart with that ` +
        `intentHash and the items — returns an immutable Cart mandate signed by ` +
        `both sides, and its cartHash. (5) submit_payment with the cartHash and a ` +
        `fresh UUID you mint as idempotencyKey — the server verifies the whole ` +
        `chain and returns a Razorpay-hosted payment link. No money moves until ` +
        `the human approves that link; their approval is the only way money moves. ` +
        `(6) Poll get_order_status until status is "paid" — the response then ` +
        `carries the merchant-signed Receipt proving your mandate chain led to ` +
        `exactly this charge.`,
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
        'an agentToken; pass it on every checkout and get_order_status call. By default the ' +
        'merchant holds your Ed25519 keypair in custody and signs on your behalf; supply ' +
        'your own publicKey instead to keep the private key client-side and sign your ' +
        'mandates locally. Registering again creates a brand-new Agent with a fresh Cap — ' +
        'the Cap of an existing registration can never be changed.',
      inputSchema: {
        capPaise: z
          .number()
          .describe(
            'Your spend ceiling with this merchant, as a positive integer number of paise. ' +
              'Not rupees, no decimals: 500000 means ₹5,000.00.',
          ),
        publicKey: z
          .string()
          .optional()
          .describe(
            'Client-side custody: your own Ed25519 public key, base64-encoded SPKI DER. ' +
              'When supplied the server stores no private key and you must sign every ' +
              'Intent/Cart/Payment mandate locally. Omit for merchant custody.',
          ),
      },
    },
    withToolErrors(async ({ capPaise, publicKey }) => {
      const registration = await registerAgent(deps.db, deps.merchantId, { capPaise, publicKey });
      return textResult({
        ...registration,
        note:
          'Keep agentToken for every subsequent call. ' +
          (registration.custody === 'client'
            ? 'The server stored only your public key: sign each mandate payload locally ' +
              '(Ed25519 over its canonical JSON) and pass the signatures to declare_intent ' +
              'and submit_payment. '
            : 'Your private key stays in merchant custody and is never returned. ') +
          'To change the Cap, register again: that mints a new Agent with the new Cap.',
      });
    }),
  );

  server.registerTool(
    'declare_intent',
    {
      title: 'Declare intent',
      description:
        'Step 1 of buying: declare WHAT you want and the most you authorize spending on it. ' +
        'Custodial Agents: the merchant signs the Intent mandate with your custodial key. ' +
        'Client-custody Agents: mint createdAt, sign the canonical payload ' +
        '{agentId, merchantId, want, budgetPaise, createdAt} locally, and pass createdAt + ' +
        'signature. Returns the intentHash — pass that to create_cart next. Requires the ' +
        'agentToken from register_agent. budgetPaise is integer paise: 300000 means ₹3,000.00.',
      inputSchema: {
        agentToken: z
          .string()
          .optional()
          .describe('Your agentToken from register_agent. Calls without a valid one refuse.'),
        want: z
          .string()
          .describe('Plain-language description of what you intend to buy, e.g. "two tees".'),
        budgetPaise: z
          .number()
          .describe(
            'Your Budget for THIS purchase, as a positive integer number of paise. ' +
              'Not rupees, no decimals: 300000 means ₹3,000.00.',
          ),
        createdAt: z
          .string()
          .optional()
          .describe(
            'Client-custody Agents only: the ISO-8601 timestamp you put in the Intent ' +
              'payload you signed. Omit for custodial Agents.',
          ),
        signature: z
          .string()
          .optional()
          .describe(
            'Client-custody Agents only: your base64 Ed25519 signature over the canonical ' +
              'JSON of the Intent payload. Omit for custodial Agents.',
          ),
      },
    },
    withToolErrors(async ({ agentToken, want, budgetPaise, createdAt, signature }) => {
      const agent = await requireRegisteredAgent(
        deps.db,
        deps.merchantId,
        agentToken,
        'declare_intent',
      );
      const result = await declareIntent(deps.db, agent, { want, budgetPaise, createdAt, signature });
      return textResult({
        intentHash: result.intentHash,
        payload: result.payload,
        signature: result.signature,
        budget: result.budget,
        nextStep:
          'Call create_cart with this intentHash and the items you want ' +
          '(variantId + quantity from get_product).',
      });
    }),
  );

  server.registerTool(
    'create_cart',
    {
      title: 'Create cart',
      description:
        'Step 2 of buying: turn an Intent into a priced, immutable Cart mandate. One shot — ' +
        'there is no cart editing; to change items, just call create_cart again (earlier ' +
        'carts stay valid and unpaid, nothing is invalidated). Pins the current catalog ' +
        'prices and is signed by the merchant key, plus your custodial key (custodial ' +
        'Agents) — client-custody Agents sign the returned payload locally and hand that ' +
        'signature to submit_payment as cartSignature. Returns the cartHash to pass to ' +
        'submit_payment. Requires the agentToken from register_agent.',
      inputSchema: {
        agentToken: z
          .string()
          .optional()
          .describe('Your agentToken from register_agent. Calls without a valid one refuse.'),
        intentHash: z.string().describe('The intentHash returned by declare_intent.'),
        items: z
          .array(
            z.object({
              variantId: z.string().describe('A variantId from get_product.'),
              quantity: z.number().int().min(1).describe('How many units. Positive integer.'),
            }),
          )
          .min(1)
          .describe('Every line of the purchase; one entry per Variant.'),
      },
    },
    withToolErrors(async ({ agentToken, intentHash, items }) => {
      const agent = await requireRegisteredAgent(
        deps.db,
        deps.merchantId,
        agentToken,
        'create_cart',
      );
      const result = await createCart(deps.db, agent, { intentHash, items });
      return textResult({
        cartHash: result.cartHash,
        payload: result.payload,
        agentSignature: result.agentSignature,
        merchantSignature: result.merchantSignature,
        total: result.total,
        items: result.items,
        nextStep:
          (result.agentSignature === null
            ? 'Sign the canonical JSON of this exact payload with your local key, then call ' +
              'submit_payment with this cartHash, that signature as cartSignature, a locally ' +
              'signed Payment mandate (paymentCreatedAt + paymentSignature), and a fresh UUID ' +
              'you mint as idempotencyKey.'
            : 'Call submit_payment with this cartHash and a fresh UUID you mint as ' +
              'idempotencyKey.') +
          ' If prices change before then, submit_payment refuses PRICE_CHANGED and you ' +
          'simply create_cart again.',
      });
    }),
  );

  server.registerTool(
    'submit_payment',
    {
      title: 'Submit payment',
      description:
        'Step 3 of buying: authorize payment of one Cart mandate. Custodial Agents: the ' +
        'server signs your Payment mandate. Client-custody Agents: sign the Payment payload ' +
        '{agentId, merchantId, cartHash, idempotencyKey, createdAt} locally and pass ' +
        'paymentCreatedAt + paymentSignature, plus cartSignature — your signature over the ' +
        'Cart payload create_cart returned. The server verifies the whole Intent → Cart → ' +
        'Payment chain (signatures, hashes, pinned prices, stock) and only then creates the ' +
        'Order and returns a Razorpay-hosted payment link. No money moves until the human ' +
        'approves that link. Mint a fresh UUID as idempotencyKey for every new payment ' +
        'attempt and reuse it only when retrying this exact cart. Requires the agentToken ' +
        'from register_agent.',
      inputSchema: {
        agentToken: z
          .string()
          .optional()
          .describe('Your agentToken from register_agent. Calls without a valid one refuse.'),
        cartHash: z.string().describe('The cartHash returned by create_cart.'),
        idempotencyKey: z
          .string()
          .min(1)
          .describe('A fresh UUID you mint for this payment attempt.'),
        cartSignature: z
          .string()
          .optional()
          .describe(
            'Client-custody Agents only: your base64 Ed25519 signature over the canonical ' +
              'JSON of the exact Cart payload create_cart returned. Omit for custodial Agents.',
          ),
        paymentCreatedAt: z
          .string()
          .optional()
          .describe(
            'Client-custody Agents only: the ISO-8601 timestamp you put in the Payment ' +
              'payload you signed. Omit for custodial Agents.',
          ),
        paymentSignature: z
          .string()
          .optional()
          .describe(
            'Client-custody Agents only: your base64 Ed25519 signature over the canonical ' +
              'JSON of the Payment payload. Omit for custodial Agents.',
          ),
      },
    },
    withToolErrors(
      async ({
        agentToken,
        cartHash,
        idempotencyKey,
        cartSignature,
        paymentCreatedAt,
        paymentSignature,
      }) => {
        // The trust gate runs first — an unregistered agent is refused before
        // any Order exists and before the gateway is ever touched.
        const agent = await requireRegisteredAgent(
          deps.db,
          deps.merchantId,
          agentToken,
          'submit_payment',
        );
        const result = await submitPayment(deps, agent, {
          cartHash,
          idempotencyKey,
          cartSignature,
          paymentCreatedAt,
          paymentSignature,
        });
        return textResult({
          orderId: result.orderId,
          status: result.status,
          total: result.total,
          items: result.items,
          paymentLinkUrl: result.paymentLinkUrl,
          gatewayPaymentLinkId: result.gatewayPaymentLinkId,
          paymentMandate: result.paymentMandate,
          nextStep:
            'Give paymentLinkUrl to your human and ask them to approve it. ' +
            'In Razorpay test mode the UPI id success@razorpay completes the payment. ' +
            `Then call get_order_status with orderId ${result.orderId}; once paid it ` +
            'includes the merchant-signed Receipt.',
          auditUrl: `${deps.publicBaseUrl}/audit/${result.orderId}`,
        });
      },
    ),
  );

  server.registerTool(
    'get_order_status',
    {
      title: 'Get order status',
      description:
        'Look up one order by the orderId returned from submit_payment. `paid` means the ' +
        'human approved the payment link and the gateway webhook confirmed it — the ' +
        'response then includes the merchant-signed Receipt (payload, signature, and the ' +
        'merchant public key to verify it with). Requires the agentToken from register_agent.',
      inputSchema: {
        agentToken: z
          .string()
          .optional()
          .describe('Your agentToken from register_agent. Calls without a valid one refuse.'),
        orderId: z.string().describe('The orderId returned by submit_payment (starts with ord_).'),
      },
    },
    withToolErrors(async ({ agentToken, orderId }) => {
      await requireRegisteredAgent(deps.db, deps.merchantId, agentToken, 'get_order_status');
      const row = await findOrderById(deps.db, deps.merchantId, orderId);
      if (row === null) {
        return validationResult(
          new ValidationError('ORDER_NOT_FOUND', `No order with id ${orderId}`),
        );
      }
      const items = await listOrderItems(deps.db, row.id);
      // Legacy single-variant Orders only; mandate-backed Orders (T4) have a
      // null variantId and carry their product detail in `items` instead.
      const variant =
        row.variantId === null
          ? null
          : await findPublishedVariant(deps.db, deps.merchantId, row.variantId);
      // The Receipt is minted by the paid webhook, so it appears exactly when
      // the status flips to paid — and only for mandate-backed Orders.
      const receipt =
        row.status === 'paid' ? await findOrderReceipt(deps.db, deps.merchantId, row.id) : null;
      return textResult({
        ...toOrderStatusView(row),
        items,
        product: variant?.productTitle ?? null,
        receipt,
        auditUrl: `${deps.publicBaseUrl}/audit/${row.id}`,
      });
    }),
  );

  return server;
}
