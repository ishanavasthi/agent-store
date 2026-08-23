import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { MERCHANT_NAME } from '../config.js';
import type { Database } from '../db/client.js';
import { listPublishedVariants, findPublishedVariant } from '../domain/catalog.js';
import { CheckoutError, checkout } from '../domain/checkout.js';
import { findOrderById, toOrderStatusView } from '../domain/orders.js';
import type { PaymentGateway } from '../gateway/types.js';

/**
 * The MCP face of the storefront core.
 *
 * Transport is authless by decision (PLAN §3, §5.2): identity, authorization
 * and spend control live *in* the protocol — the agent token and mandate chain
 * of T3/T4 — not in a header. T1 has neither yet, so these tools are open.
 *
 * A fresh `McpServer` is built per HTTP request (stateless Streamable HTTP), so
 * this function must stay cheap and hold no per-connection state.
 */

export interface McpDeps {
  readonly db: Database;
  readonly gateway: PaymentGateway;
  readonly merchantId: string;
  readonly publicBaseUrl: string;
}

function textResult(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

function errorResult(code: string, message: string) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify({ code, message }, null, 2) }],
  };
}

export function createMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer(
    { name: 'agent-store', version: '0.1.0' },
    {
      instructions:
        `Storefront for ${MERCHANT_NAME}. Prices are integer paise (INR). ` +
        `Call get_product to see what is for sale, checkout to buy it. ` +
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
        currency: 'INR',
        note: 'All prices are integer paise. 49900 paise = ₹499.00.',
        variants: catalogue,
      });
    },
  );

  server.registerTool(
    'checkout',
    {
      title: 'Checkout',
      description:
        'Create an order and return a Razorpay-hosted payment link for the human to approve. ' +
        'No money moves until the human approves that link. Omit variantId to buy the ' +
        "merchant's only published Variant.",
      inputSchema: {
        variantId: z
          .string()
          .optional()
          .describe('Variant to buy, from get_product. Omit if the merchant sells only one.'),
        quantity: z.number().int().min(1).max(10).default(1).describe('How many units to buy.'),
      },
    },
    async ({ variantId, quantity }) => {
      try {
        const result = await checkout(
          { db: deps.db, gateway: deps.gateway, publicBaseUrl: deps.publicBaseUrl },
          { merchantId: deps.merchantId, variantId, quantity: quantity ?? 1 },
        );
        return textResult({
          orderId: result.orderId,
          status: result.status,
          amountPaise: result.amountPaise,
          amountDisplay: result.amountDisplay,
          currency: result.currency,
          quantity: result.quantity,
          product: result.variant.productTitle,
          variantId: result.variant.variantId,
          paymentLinkUrl: result.paymentLinkUrl,
          gatewayOrderId: result.gatewayOrderId,
          nextStep:
            'Give paymentLinkUrl to your human and ask them to approve it. ' +
            'In Razorpay test mode the UPI id success@razorpay completes the payment. ' +
            `Then call get_order_status with orderId ${result.orderId}.`,
          auditUrl: `${deps.publicBaseUrl}/audit/${result.orderId}`,
        });
      } catch (error) {
        if (error instanceof CheckoutError) return errorResult(error.code, error.message);
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
        'approved the payment link and the gateway webhook confirmed it.',
      inputSchema: {
        orderId: z.string().describe('The orderId returned by checkout (starts with ord_).'),
      },
    },
    async ({ orderId }) => {
      const row = await findOrderById(deps.db, deps.merchantId, orderId);
      if (row === null) {
        return errorResult('ORDER_NOT_FOUND', `No order with id ${orderId}`);
      }
      const view = toOrderStatusView(row);
      const variant = await findPublishedVariant(deps.db, deps.merchantId, row.variantId);
      return textResult({
        ...view,
        product: variant?.productTitle ?? null,
        auditUrl: `${deps.publicBaseUrl}/audit/${row.id}`,
      });
    },
  );

  return server;
}
