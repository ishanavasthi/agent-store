import { and, asc, desc, eq, gte, inArray, isNull, notInArray, sql, type SQL } from 'drizzle-orm';
import type { Database, Executor, Transaction } from '../db/client.js';
import {
  orderItems,
  orders,
  products,
  variants,
  type OrderRow,
  type OrderStatus,
} from '../db/schema.js';
import type { GatewayWebhookEvent } from '../gateway/types.js';
import { namespaceGatewayEvent, type AnomalyReason } from './auditEvents.js';
import { appendAuditEvent } from './auditLog.js';
import {
  declinePayload,
  parseDeclinePayload,
  PAYMENT_ATTEMPT_LIMIT,
  type DeclinePayload,
} from './decline.js';
import { moneyView, paise, type MoneyView } from './money.js';
import {
  parseOversellPayload,
  type OversellPayload,
  type OversellShortfallLine,
  type StoredOversellShortfall,
} from './oversell.js';
import { mintReceiptForPaidOrder } from './receipts.js';

/** The statuses a payment attempt (success or failure) can still act on. */
const PAYABLE_STATUSES: readonly OrderStatus[] = ['created', 'awaiting_payment'];

/**
 * Domain Order reads, and the one write that money depends on: marking an
 * Order paid — and minting its merchant-signed Receipt — when a verified
 * gateway webhook says so.
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

/** How a webhook was attributed to an Order, strongest first. */
export type WebhookMatchStrategy = 'reference' | 'gateway_payment_link_id' | 'gateway_order_id';

export interface WebhookMatch {
  readonly order: OrderRow;
  readonly matchedBy: WebhookMatchStrategy;
  /** More than one Order matched. Fail closed rather than pick one. */
  readonly ambiguous: boolean;
}

/**
 * Find the Order a webhook is about, deterministically.
 *
 * Strategies are tried in strict priority order rather than OR-ed into one
 * query: an OR with `LIMIT 1` and no `ORDER BY` lets the planner decide which
 * Order gets marked paid, which is not a decision a query planner should be
 * making. `reference` wins because it is our own domain Order id, echoed back
 * from a field we set ourselves.
 *
 * Two rows are fetched, not one, so a multi-match is *detected* rather than
 * silently resolved; the ordering makes the first row stable either way.
 */
export async function findOrderForWebhook(
  executor: Executor,
  merchantId: string,
  event: GatewayWebhookEvent,
): Promise<WebhookMatch | null> {
  const strategies: readonly { readonly by: WebhookMatchStrategy; readonly where: SQL }[] = [
    ...(event.reference === null
      ? []
      : [{ by: 'reference' as const, where: eq(orders.id, event.reference) }]),
    ...(event.gatewayPaymentLinkId === null
      ? []
      : [
          {
            by: 'gateway_payment_link_id' as const,
            where: eq(orders.gatewayPaymentLinkId, event.gatewayPaymentLinkId),
          },
        ]),
    ...(event.gatewayOrderId === null
      ? []
      : [
          {
            by: 'gateway_order_id' as const,
            where: eq(orders.gatewayOrderId, event.gatewayOrderId),
          },
        ]),
  ];

  for (const strategy of strategies) {
    const rows = await executor
      .select()
      .from(orders)
      .where(and(eq(orders.merchantId, merchantId), strategy.where))
      .orderBy(asc(orders.createdAt), asc(orders.id))
      .limit(2);

    const first = rows[0];
    if (first !== undefined) {
      return { order: first, matchedBy: strategy.by, ambiguous: rows.length > 1 };
    }
  }

  return null;
}

export interface OrderStatusView {
  readonly orderId: string;
  readonly status: OrderStatus;
  readonly total: MoneyView;
  /** Null on multi-item Orders (T4): the legacy single-variant columns are unset there. */
  readonly quantity: number | null;
  readonly gatewayOrderId: string | null;
  readonly gatewayPaymentId: string | null;
  readonly gatewayPaymentLinkId: string | null;
  readonly paymentLinkUrl: string | null;
  readonly createdAt: string;
  readonly paidAt: string | null;
  readonly cancelledAt: string | null;
  readonly refundedAt: string | null;
  /**
   * The structured reason a fail-closed cancellation stored (T8). A Decline —
   * the gateway's no, after the trust layer's yes — never a Refusal, and the
   * wire shape keeps them distinct (`kind: 'decline'`, no `recoverable`).
   */
  readonly decline: DeclinePayload | null;
  /**
   * The structured reason a refunded Order stored (T9). An Oversell — a
   * fulfilment-time stock shortfall discovered after capture, automatically
   * refunded — never a Refusal and never a Decline, and the wire shape keeps
   * all three distinct (`kind: 'oversell'`, no `recoverable`, no `attempts`).
   */
  readonly oversell: OversellPayload | null;
}

export function toOrderStatusView(row: OrderRow): OrderStatusView {
  return {
    orderId: row.id,
    status: row.status,
    total: moneyView(paise(row.amountPaise)),
    quantity: row.quantity,
    gatewayOrderId: row.gatewayOrderId,
    gatewayPaymentId: row.gatewayPaymentId,
    gatewayPaymentLinkId: row.gatewayPaymentLinkId,
    paymentLinkUrl: row.paymentLinkUrl,
    createdAt: row.createdAt.toISOString(),
    paidAt: row.paidAt === null ? null : row.paidAt.toISOString(),
    cancelledAt: row.cancelledAt === null ? null : row.cancelledAt.toISOString(),
    refundedAt: row.refundedAt === null ? null : row.refundedAt.toISOString(),
    decline: parseDeclinePayload(row.cancellationReason),
    oversell: parseOversellPayload(row.refundReason),
  };
}

/** One row of the `GET /audit` directory — just enough for the viewer's list. */
export interface OrderDirectoryEntry {
  readonly orderId: string;
  readonly status: OrderStatus;
  readonly total: MoneyView;
  readonly createdAt: string;
}

/** The Merchant's most recent Orders, newest first, for the audit directory. */
export async function listRecentOrders(
  executor: Executor,
  merchantId: string,
  limit: number,
): Promise<OrderDirectoryEntry[]> {
  const rows = await executor
    .select()
    .from(orders)
    .where(eq(orders.merchantId, merchantId))
    // `id` breaks createdAt ties so the directory order is deterministic.
    .orderBy(desc(orders.createdAt), desc(orders.id))
    .limit(limit);

  return rows.map((row) => ({
    orderId: row.id,
    status: row.status,
    total: moneyView(paise(row.amountPaise)),
    createdAt: row.createdAt.toISOString(),
  }));
}

export type WebhookOutcome =
  | { readonly result: 'order_paid'; readonly orderId: string }
  | { readonly result: 'already_paid'; readonly orderId: string }
  | { readonly result: 'recorded'; readonly orderId: string }
  /** T8: a Decline counted against the attempt limit; the Order still waits. */
  | {
      readonly result: 'decline_recorded';
      readonly orderId: string;
      readonly attempt: number;
      readonly retriesRemaining: number;
    }
  /** T8: the attempt limit is exhausted — the Order failed closed. */
  | {
      readonly result: 'order_cancelled';
      readonly orderId: string;
      readonly decline: DeclinePayload;
    }
  /**
   * T9: the capture stood and the Order is paid, but the fulfilment-time stock
   * re-check came up short — the caller must now run the automatic refund
   * (`refundOversoldOrder`); the shortfall is already stored on the Order row.
   */
  | {
      readonly result: 'oversell_detected';
      readonly orderId: string;
      readonly shortfalls: readonly OversellShortfallLine[];
    }
  | { readonly result: 'anomaly'; readonly orderId: string; readonly reason: AnomalyReason }
  | { readonly result: 'unmatched'; readonly orderId: null };

/**
 * Apply an *already-signature-verified* gateway webhook.
 *
 * Both the `gateway.webhook_received` event and any resulting state change
 * commit in one transaction (ADR-0003), so the log can never show a payment
 * arriving without showing what it did — or vice versa.
 *
 * Fail-closed, in three places. An Order is **not** marked paid when:
 *   - more than one Order matched the webhook,
 *   - the webhook reports a gateway order id different from one already
 *     recorded (the payment may have hit a different object),
 *   - the webhook's amount is missing, or differs from the Order's amount.
 * Each case writes an `order.anomaly_detected` event and leaves the Order
 * exactly as it was. Nothing is ever silently overwritten or swallowed.
 *
 * Idempotent by design: Razorpay sends both `payment_link.paid` and
 * `payment.captured` for one purchase and redelivers on any non-2xx, so
 * re-entry must be free. The `UPDATE ... WHERE status <> 'paid'` guard is what
 * makes "paid" a one-way transition rather than a repeated one.
 */
export async function applyGatewayWebhook(
  db: Database,
  merchantId: string,
  event: GatewayWebhookEvent,
  gatewayName: string,
): Promise<WebhookOutcome> {
  const gatewayEvent = namespaceGatewayEvent(gatewayName, event.rawEvent);
  const match = await findOrderForWebhook(db, merchantId, event);

  if (match === null) {
    // Nothing to attribute it to — most likely an event for another deployment
    // sharing the test account. Recorded, but not against an Order.
    await db.transaction(async (tx) => {
      await appendAuditEvent(tx, {
        type: 'gateway.webhook_received',
        merchantId,
        orderId: null,
        payload: {
          gateway: gatewayName,
          gatewayEvent,
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

  const { order } = match;

  return db.transaction(async (tx) => {
    const anomaly = async (
      reason: AnomalyReason,
      detail: Record<string, unknown>,
    ): Promise<WebhookOutcome> => {
      await appendAuditEvent(tx, {
        type: 'order.anomaly_detected',
        merchantId,
        orderId: order.id,
        payload: { gateway: gatewayName, gatewayEvent, reason, ...detail },
      });
      return { result: 'anomaly', orderId: order.id, reason };
    };

    await appendAuditEvent(tx, {
      type: 'gateway.webhook_received',
      merchantId,
      orderId: order.id,
      payload: {
        gateway: gatewayName,
        gatewayEvent,
        kind: event.kind,
        matched: true,
        matchedBy: match.matchedBy,
        gatewayOrderId: event.gatewayOrderId,
        gatewayPaymentId: event.gatewayPaymentId,
        gatewayPaymentLinkId: event.gatewayPaymentLinkId,
        webhookAmountPaise: event.amountPaise,
      },
    });

    if (match.ambiguous) {
      return anomaly('ambiguous_webhook_match', { matchedBy: match.matchedBy });
    }

    // --- Learn the real gateway order id, exactly once ----------------------
    // Razorpay fires several webhooks for one purchase (payment_link.paid,
    // payment.captured, order.paid) effectively at once. Testing the value read
    // earlier in this transaction and then writing unconditionally is a
    // read-then-write race: every concurrent webhook sees NULL and every one of
    // them links, producing one `order_linked` event per webhook for a single
    // real linking. The guard therefore lives in the WHERE clause, exactly as
    // it does for the paid transition below: under READ COMMITTED the losers
    // block on the row lock, re-evaluate `IS NULL` after the winner commits,
    // and match nothing.
    if (event.gatewayOrderId !== null) {
      const [linked] = await tx
        .update(orders)
        .set({ gatewayOrderId: event.gatewayOrderId, updatedAt: new Date() })
        .where(and(eq(orders.id, order.id), isNull(orders.gatewayOrderId)))
        .returning();

      if (linked !== undefined) {
        await appendAuditEvent(tx, {
          type: 'gateway.order_linked',
          merchantId,
          orderId: order.id,
          payload: { gateway: gatewayName, gatewayEvent, gatewayOrderId: event.gatewayOrderId },
        });
      } else {
        // Already linked — by an earlier webhook or a concurrent one. Re-read
        // rather than trusting the stale snapshot, so a genuine conflict is
        // still caught. Never overwrite: a second, different gateway order for
        // one domain Order means we do not know which object the money hit.
        const current = await tx.query.orders.findFirst({ where: eq(orders.id, order.id) });
        if (current !== undefined && current.gatewayOrderId !== event.gatewayOrderId) {
          return anomaly('gateway_order_id_conflict', {
            recordedGatewayOrderId: current.gatewayOrderId,
            webhookGatewayOrderId: event.gatewayOrderId,
          });
        }
      }
    }

    if (event.kind === 'payment_failed') {
      return applyDecline(tx, merchantId, order, event, gatewayName, gatewayEvent);
    }

    if (event.kind !== 'payment_succeeded') {
      return { result: 'recorded', orderId: order.id } as const;
    }

    // --- Assert the amount before any money is acknowledged -----------------
    if (event.amountPaise === null) {
      return anomaly('amount_missing', { expectedAmountPaise: order.amountPaise });
    }
    if (event.amountPaise !== order.amountPaise) {
      return anomaly('amount_mismatch', {
        expectedAmountPaise: order.amountPaise,
        webhookAmountPaise: event.amountPaise,
      });
    }

    const paidAt = new Date();
    // `paid` is a one-way transition, and since T8 it is also unreachable from
    // `cancelled`: once the Order failed closed and the buyer was told "zero
    // charge", a late capture must surface as a conflict, never as a silent
    // paid flip. Since T9 it is unreachable from `refunded` too: a redelivered
    // capture must not flip a refunded Order back to paid. All guards live in
    // the WHERE clause (the house pattern).
    const updated = await tx
      .update(orders)
      .set({
        status: 'paid',
        paidAt,
        updatedAt: paidAt,
        ...(event.gatewayPaymentId === null ? {} : { gatewayPaymentId: event.gatewayPaymentId }),
      })
      .where(
        and(
          eq(orders.id, order.id),
          eq(orders.merchantId, merchantId),
          notInArray(orders.status, ['paid', 'cancelled', 'refunded']),
        ),
      )
      .returning({ id: orders.id });

    if (updated.length === 0) {
      // Zero rows means paid or cancelled won the row first — re-read rather
      // than trusting the pre-transaction snapshot to say which.
      const current = await tx.query.orders.findFirst({ where: eq(orders.id, order.id) });
      if (current?.status === 'cancelled') {
        return anomaly('payment_after_cancellation', {
          gatewayPaymentId: event.gatewayPaymentId,
          webhookAmountPaise: event.amountPaise,
          cancelledAt: current.cancelledAt?.toISOString() ?? null,
        });
      }
      // Already paid by an earlier delivery of this or a sibling event (or
      // paid and since refunded — the capture is old news either way). No
      // second `order.paid` is written: the transition happened exactly once.
      return { result: 'already_paid', orderId: order.id } as const;
    }

    await appendAuditEvent(tx, {
      type: 'order.paid',
      merchantId,
      orderId: order.id,
      payload: {
        gateway: gatewayName,
        gatewayEvent,
        gatewayPaymentId: event.gatewayPaymentId,
        gatewayOrderId: event.gatewayOrderId,
        // The amount the *gateway* reported, which is what was actually paid.
        // It equalled the Order's amount — that is asserted above, not assumed.
        amountPaise: event.amountPaise,
        currency: order.currency,
        paidAt: paidAt.toISOString(),
      },
    });

    // Mint the merchant-signed Receipt in this same transaction. Exactly-once
    // rides the one-way paid UPDATE above: only the delivery that won the
    // `status <> 'paid'` transition reaches this line, so Razorpay's
    // near-simultaneous sibling webhooks (see engineering log) can never mint
    // twice — the `already_paid` branch returned before it.
    await mintReceiptForPaidOrder(tx, {
      merchantId,
      orderId: order.id,
      amountPaise: event.amountPaise,
      gatewayPaymentId: event.gatewayPaymentId ?? order.gatewayPaymentId,
      issuedAt: paidAt,
      gatewayName,
      gatewayEvent,
    });

    // Fulfilment: the no-reservation model's second stock check (PLAN §5.2),
    // in this same transaction — the decrement (or the shortfall that starts
    // the refund path) commits with the paid transition and its events, and
    // exactly-once rides the same one-way paid UPDATE the Receipt does.
    return fulfillPaidOrder(tx, merchantId, order.id, paidAt, gatewayName, gatewayEvent);
  });
}

/**
 * Decrement stock for every line of a just-paid Order — the fulfilment-time
 * re-check the no-reservation model promises (PLAN §5.2, DECISIONS 2026-08-23
 * "No stock reservations"). Runs inside `applyGatewayWebhook`'s paid
 * transaction, only on the delivery that won the one-way paid transition.
 *
 * Each line is the prescribed atomic conditional update —
 * `UPDATE … SET stock = stock - qty WHERE stock >= qty` — never a
 * check-then-write: the decrement *is* the check, so two rival captures
 * serialise on the row and exactly one wins the last unit. A line whose update
 * matches no row is the Oversell. An oversold Order fulfils nothing: lines
 * that had already decremented are restored (same transaction, deterministic),
 * the shortfall is stored on the Order row for the refund step to read
 * (ADR-0003: never rebuilt from the log), and `order.oversell_detected` is
 * appended. The Order stays `paid` — money really moved — until
 * `refundOversoldOrder` moves it to `refunded`.
 */
async function fulfillPaidOrder(
  tx: Transaction,
  merchantId: string,
  orderId: string,
  paidAt: Date,
  gatewayName: string,
  gatewayEvent: string,
): Promise<WebhookOutcome> {
  // Line items, with titles for the buyer-facing shortfall report. Legacy
  // single-variant Orders (pre-T4) carry their one line on the Order row.
  let lines = await tx
    .select({
      variantId: orderItems.variantId,
      quantity: orderItems.quantity,
      productTitle: products.title,
    })
    .from(orderItems)
    .innerJoin(variants, eq(orderItems.variantId, variants.id))
    .innerJoin(products, eq(variants.productId, products.id))
    .where(eq(orderItems.orderId, orderId))
    .orderBy(asc(orderItems.variantId));
  if (lines.length === 0) {
    const [legacy] = await tx
      .select({
        variantId: orders.variantId,
        quantity: orders.quantity,
        productTitle: products.title,
      })
      .from(orders)
      .innerJoin(variants, eq(orders.variantId, variants.id))
      .innerJoin(products, eq(variants.productId, products.id))
      .where(eq(orders.id, orderId))
      .limit(1);
    if (legacy !== undefined && legacy.variantId !== null && legacy.quantity !== null) {
      lines = [
        {
          variantId: legacy.variantId,
          quantity: legacy.quantity,
          productTitle: legacy.productTitle,
        },
      ];
    }
  }

  const decremented: { readonly variantId: string; readonly quantity: number }[] = [];
  const fulfilled: { variantId: string; quantity: number; remainingStock: number }[] = [];
  const shortfalls: OversellShortfallLine[] = [];

  for (const line of lines) {
    const [hit] = await tx
      .update(variants)
      .set({ stock: sql`${variants.stock} - ${line.quantity}` })
      .where(and(eq(variants.id, line.variantId), gte(variants.stock, line.quantity)))
      .returning({ stock: variants.stock });

    if (hit !== undefined) {
      decremented.push({ variantId: line.variantId, quantity: line.quantity });
      fulfilled.push({
        variantId: line.variantId,
        quantity: line.quantity,
        // The winning UPDATE's `stock >= qty` guard proves stock was a number
        // (a null-stock Variant can never satisfy it), so the row is non-null.
        remainingStock: hit.stock!,
      });
      continue;
    }

    // The miss IS the detection. Reading the stock afterwards is reporting
    // detail for the buyer's structured reason, never a guard.
    const [current] = await tx
      .select({ stock: variants.stock })
      .from(variants)
      .where(eq(variants.id, line.variantId))
      .limit(1);
    shortfalls.push({
      variantId: line.variantId,
      productTitle: line.productTitle,
      requested: line.quantity,
      available: current?.stock ?? 0,
    });
  }

  if (shortfalls.length === 0) {
    await appendAuditEvent(tx, {
      type: 'order.fulfilled',
      merchantId,
      orderId,
      payload: { gateway: gatewayName, gatewayEvent, lines: fulfilled },
    });
    return { result: 'order_paid', orderId } as const;
  }

  // Oversold: restore the lines that had decremented — an oversold Order
  // fulfils nothing, and the remaining stock belongs to other buyers.
  for (const line of decremented) {
    await tx
      .update(variants)
      .set({ stock: sql`${variants.stock} + ${line.quantity}` })
      .where(eq(variants.id, line.variantId));
  }

  const stored: StoredOversellShortfall = {
    detectedAt: paidAt.toISOString(),
    shortfalls,
  };
  await tx
    .update(orders)
    .set({ oversellShortfall: stored, updatedAt: paidAt })
    .where(and(eq(orders.id, orderId), eq(orders.merchantId, merchantId)));

  await appendAuditEvent(tx, {
    type: 'order.oversell_detected',
    merchantId,
    orderId,
    payload: {
      gateway: gatewayName,
      gatewayEvent,
      shortfalls,
      detectedAt: paidAt.toISOString(),
    },
  });

  return { result: 'oversell_detected', orderId, shortfalls } as const;
}

/**
 * Apply a Decline — the gateway's no, after the trust layer's yes (T8,
 * PLAN §5.6 failure 1). Runs inside `applyGatewayWebhook`'s transaction, so
 * the attempt count, any cancellation, and their audit events commit together
 * (ADR-0003).
 *
 * The bound: an Order tolerates PAYMENT_ATTEMPT_LIMIT *distinct* failed
 * gateway payments — the original attempt and exactly one retry. The set of
 * counted attempts lives on the Order row as their gateway payment ids, so a
 * redelivered `payment.failed` (same payment id) is free rather than a second
 * counted attempt, and no state is ever rebuilt from the audit log. Both the
 * membership check and the status guard live in the UPDATE's WHERE clause —
 * the house exactly-once pattern (see engineering log, order_linked ×3).
 *
 * Exhausting the limit fails the Order closed in the same transaction:
 * `cancelled`, with a structured DeclinePayload stored on the row for
 * get_order_status to report — a Decline, never a Refusal. Zero charge: the
 * Order never reached `paid`, and after cancellation the paid transition is
 * unreachable (a late capture records `payment_after_cancellation` instead).
 */
async function applyDecline(
  tx: Transaction,
  merchantId: string,
  order: OrderRow,
  event: GatewayWebhookEvent,
  gatewayName: string,
  gatewayEvent: string,
): Promise<WebhookOutcome> {
  const failedPaymentId = event.gatewayPaymentId;
  if (failedPaymentId === null) {
    // An attempt is identified by its gateway payment id; without one the
    // failure cannot be deduplicated against redelivery, so it is recorded
    // (the `gateway.webhook_received` event above) but never counted — the
    // bound must count real attempts, not deliveries.
    return { result: 'recorded', orderId: order.id };
  }

  const now = new Date();
  const [counted] = await tx
    .update(orders)
    .set({
      declinedGatewayPaymentIds: sql`array_append(${orders.declinedGatewayPaymentIds}, ${failedPaymentId})`,
      updatedAt: now,
    })
    .where(
      and(
        eq(orders.id, order.id),
        eq(orders.merchantId, merchantId),
        inArray(orders.status, PAYABLE_STATUSES),
        sql`NOT (${failedPaymentId} = ANY(${orders.declinedGatewayPaymentIds}))`,
      ),
    )
    .returning({ declinedGatewayPaymentIds: orders.declinedGatewayPaymentIds });

  if (counted === undefined) {
    // Either this payment id was already counted (a redelivery — free by
    // design) or the Order left the payable statuses first (paid by a
    // concurrent capture, or already cancelled). Nothing to advance.
    return { result: 'recorded', orderId: order.id };
  }

  const attempt = counted.declinedGatewayPaymentIds.length;
  const retriesRemaining = Math.max(0, PAYMENT_ATTEMPT_LIMIT - attempt);
  await appendAuditEvent(tx, {
    type: 'payment.declined',
    merchantId,
    orderId: order.id,
    payload: {
      gateway: gatewayName,
      gatewayEvent,
      gatewayPaymentId: failedPaymentId,
      gatewayErrorCode: event.gatewayErrorCode,
      gatewayErrorDescription: event.gatewayErrorDescription,
      amountPaise: event.amountPaise,
      attempt,
      attemptLimit: PAYMENT_ATTEMPT_LIMIT,
      retriesRemaining,
    },
  });

  if (attempt < PAYMENT_ATTEMPT_LIMIT) {
    return { result: 'decline_recorded', orderId: order.id, attempt, retriesRemaining };
  }

  // The bounded retry is spent — fail closed. The guard re-checks the status
  // even though this transaction just won the row above: belt and braces cost
  // one WHERE clause, and a zero-row cancel is then impossible rather than
  // assumed impossible.
  const decline = declinePayload({
    attempts: attempt,
    gatewayErrorCode: event.gatewayErrorCode,
    gatewayErrorDescription: event.gatewayErrorDescription,
  });
  const cancelled = await tx
    .update(orders)
    .set({ status: 'cancelled', cancelledAt: now, cancellationReason: decline, updatedAt: now })
    .where(
      and(
        eq(orders.id, order.id),
        eq(orders.merchantId, merchantId),
        inArray(orders.status, PAYABLE_STATUSES),
      ),
    )
    .returning({ id: orders.id });
  if (cancelled.length === 0) {
    return { result: 'recorded', orderId: order.id };
  }

  await appendAuditEvent(tx, {
    type: 'order.cancelled',
    merchantId,
    orderId: order.id,
    payload: {
      gateway: gatewayName,
      gatewayEvent,
      gatewayPaymentId: failedPaymentId,
      cancelledAt: now.toISOString(),
      // The exact structured reason stored on the row and reported to the
      // buyer — the ledger shows what the buyer was told, not a paraphrase.
      decline: { ...decline },
    },
  });

  return { result: 'order_cancelled', orderId: order.id, decline };
}

/** One purchased line of an Order, as `get_order_status` reports it. */
export interface OrderItemView {
  readonly variantId: string;
  readonly productTitle: string;
  readonly label: string | null;
  readonly quantity: number;
  readonly unitPrice: MoneyView;
}

/**
 * An Order's line items, joined to their catalog rows for display. Deliberately
 * NOT filtered to `published`: a purchase already made must keep reporting what
 * it bought even after the merchant unpublishes the product.
 */
export async function listOrderItems(
  executor: Executor,
  orderId: string,
): Promise<OrderItemView[]> {
  const rows = await executor
    .select({
      variantId: orderItems.variantId,
      productTitle: products.title,
      label: variants.label,
      quantity: orderItems.quantity,
      unitPricePaise: orderItems.unitPricePaise,
    })
    .from(orderItems)
    .innerJoin(variants, eq(orderItems.variantId, variants.id))
    .innerJoin(products, eq(variants.productId, products.id))
    .where(eq(orderItems.orderId, orderId))
    .orderBy(asc(orderItems.variantId));
  return rows.map((row) => ({
    variantId: row.variantId,
    productTitle: row.productTitle,
    label: row.label,
    quantity: row.quantity,
    unitPrice: moneyView(paise(row.unitPricePaise)),
  }));
}

