import { and, eq, ne, or } from 'drizzle-orm';
import type { Database, Executor } from '../db/client.js';
import { orders } from '../db/schema.js';
import type { OrderRow } from '../db/schema.js';
import type { GatewayWebhookEvent } from '../gateway/types.js';
import { appendAuditEvent } from './auditLog.js';
import { formatPaise, paise } from './money.js';

/**
 * Domain Order reads, and the one write that money depends on: marking an
 * Order paid when a verified gateway webhook says so.
 */

export async function findOrderById(
  executor: Executor,
  merchantId: string,
  orderId: string,
): Promise<OrderRow | null> {
  const rows = await executor
    .select()
    .from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.merchantId, merchantId)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Find the Order a webhook is about.
 *
 * Razorpay hands back our domain Order id as the Payment Link's `reference_id`
 * (and in `notes`), so that is the primary key path. The gateway identifiers
 * are fallbacks for events that carry one but not the other.
 */
export async function findOrderForWebhook(
  executor: Executor,
  merchantId: string,
  event: GatewayWebhookEvent,
): Promise<OrderRow | null> {
  const matchers = [
    event.reference === null ? null : eq(orders.id, event.reference),
    event.gatewayPaymentLinkId === null
      ? null
      : eq(orders.gatewayPaymentLinkId, event.gatewayPaymentLinkId),
    event.gatewayOrderId === null ? null : eq(orders.gatewayOrderId, event.gatewayOrderId),
  ].filter((m): m is Exclude<typeof m, null> => m !== null);

  if (matchers.length === 0) return null;

  const rows = await executor
    .select()
    .from(orders)
    .where(and(eq(orders.merchantId, merchantId), or(...matchers)))
    .limit(1);
  return rows[0] ?? null;
}

export interface OrderStatusView {
  readonly orderId: string;
  readonly status: string;
  readonly amountPaise: number;
  readonly amountDisplay: string;
  readonly currency: string;
  readonly quantity: number;
  readonly gatewayOrderId: string | null;
  readonly gatewayPaymentId: string | null;
  readonly paymentLinkUrl: string | null;
  readonly createdAt: string;
  readonly paidAt: string | null;
}

export function toOrderStatusView(row: OrderRow): OrderStatusView {
  return {
    orderId: row.id,
    status: row.status,
    amountPaise: row.amountPaise,
    amountDisplay: formatPaise(paise(row.amountPaise)),
    currency: row.currency,
    quantity: row.quantity,
    gatewayOrderId: row.gatewayOrderId,
    gatewayPaymentId: row.gatewayPaymentId,
    paymentLinkUrl: row.paymentLinkUrl,
    createdAt: row.createdAt.toISOString(),
    paidAt: row.paidAt === null ? null : row.paidAt.toISOString(),
  };
}

export type WebhookOutcome =
  | { readonly result: 'order_paid'; readonly orderId: string }
  | { readonly result: 'already_paid'; readonly orderId: string }
  | { readonly result: 'recorded'; readonly orderId: string }
  | { readonly result: 'unmatched'; readonly orderId: null };

/**
 * Apply a *already-signature-verified* gateway webhook.
 *
 * Both the `gateway.webhook_received` event and any resulting state change
 * commit in one transaction (ADR-0003), so the log can never show a payment
 * arriving without showing what it did — or vice versa.
 *
 * Idempotent by design: Razorpay sends both `payment_link.paid` and
 * `payment.captured` for one purchase and redelivers on any non-2xx reply, so
 * re-entry must be free. The `UPDATE ... WHERE status <> 'paid'` guard is what
 * makes "paid" a one-way transition rather than a repeated one.
 */
export async function applyGatewayWebhook(
  db: Database,
  merchantId: string,
  event: GatewayWebhookEvent,
  gatewayName: string,
): Promise<WebhookOutcome> {
  const order = await findOrderForWebhook(db, merchantId, event);

  if (order === null) {
    // Nothing to attribute it to — most likely an event for another
    // deployment sharing the test account. Recorded, but not against an Order.
    await db.transaction(async (tx) => {
      await appendAuditEvent(tx, {
        type: 'gateway.webhook_received',
        merchantId,
        orderId: null,
        payload: {
          gateway: gatewayName,
          rawEvent: event.rawEvent,
          kind: event.kind,
          matched: false,
          reference: event.reference,
          gatewayOrderId: event.gatewayOrderId,
          gatewayPaymentId: event.gatewayPaymentId,
        },
      });
    });
    return { result: 'unmatched', orderId: null };
  }

  return db.transaction(async (tx) => {
    await appendAuditEvent(tx, {
      type: 'gateway.webhook_received',
      merchantId,
      orderId: order.id,
      payload: {
        gateway: gatewayName,
        rawEvent: event.rawEvent,
        kind: event.kind,
        matched: true,
        gatewayOrderId: event.gatewayOrderId,
        gatewayPaymentId: event.gatewayPaymentId,
        gatewayPaymentLinkId: event.gatewayPaymentLinkId,
        amountPaise: event.amountPaise,
      },
    });

    if (event.kind !== 'payment_succeeded') {
      // T-later: a Decline drives the bounded-retry / fail-closed path (PLAN §5.6).
      return { result: 'recorded', orderId: order.id } as const;
    }

    const paidAt = new Date();
    const updated = await tx
      .update(orders)
      .set({
        status: 'paid',
        paidAt,
        updatedAt: paidAt,
        ...(event.gatewayPaymentId === null ? {} : { gatewayPaymentId: event.gatewayPaymentId }),
        ...(event.gatewayOrderId === null ? {} : { gatewayOrderId: event.gatewayOrderId }),
      })
      .where(
        and(
          eq(orders.id, order.id),
          eq(orders.merchantId, merchantId),
          ne(orders.status, 'paid'),
        ),
      )
      .returning({ id: orders.id });

    if (updated.length === 0) {
      // Already paid by an earlier delivery of this or a sibling event. No
      // second `order.paid` is written: the transition happened exactly once.
      return { result: 'already_paid', orderId: order.id } as const;
    }

    await appendAuditEvent(tx, {
      type: 'order.paid',
      merchantId,
      orderId: order.id,
      payload: {
        gatewayPaymentId: event.gatewayPaymentId,
        gatewayOrderId: event.gatewayOrderId,
        amountPaise: order.amountPaise,
        currency: order.currency,
        paidAt: paidAt.toISOString(),
      },
    });

    return { result: 'order_paid', orderId: order.id } as const;
  });
}
