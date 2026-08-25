import { randomUUID } from 'node:crypto';

/**
 * Prefixed, human-scannable identifiers. The prefix is what stops a domain
 * Order id from ever being mistaken for a `gatewayOrderId` (CONTEXT.md →
 * Gateway order): ours read `ord_...`, Razorpay's read `order_...`/`plink_...`.
 */
const PREFIXES = {
  order: 'ord',
  product: 'prd',
  variant: 'var',
  agent: 'agt',
  orderItem: 'itm',
  // The mandate family reads as `<i|c|p>md_` — intent/cart/payment mandate.
  // Deliberately not `pay_`: that is Razorpay's prefix for gateway payment ids,
  // and the two must never be mistaken for one another in a log.
  intentMandate: 'imd',
  cartMandate: 'cmd',
  paymentMandate: 'pmd',
  receipt: 'rcp',
} as const;

export type IdKind = keyof typeof PREFIXES;

export function newId(kind: IdKind): string {
  return `${PREFIXES[kind]}_${randomUUID().replaceAll('-', '')}`;
}

/**
 * Razorpay's `reference_id` on a gateway order / Payment Link is capped at 40
 * characters and must be unique per merchant. Our Order ids are 36 characters,
 * so they fit as-is — which is what lets a webhook find its domain Order.
 */
export const GATEWAY_REFERENCE_MAX_LENGTH = 40;

export function toGatewayReference(orderId: string): string {
  if (orderId.length > GATEWAY_REFERENCE_MAX_LENGTH) {
    throw new Error(
      `Order id ${orderId} is ${orderId.length} chars; Razorpay reference_id allows ${GATEWAY_REFERENCE_MAX_LENGTH}`,
    );
  }
  return orderId;
}
