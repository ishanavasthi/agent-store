import { and, eq } from 'drizzle-orm';
import { orders } from '../db/schema.js';
import type { StorefrontDeps } from '../deps.js';
import { appendAuditEvent } from './auditLog.js';
import { formatPaise, paise, type Paise } from './money.js';
import { findOrderById } from './orders.js';
import { mintRefundReceiptForOrder } from './receipts.js';

/**
 * The Oversell vocabulary and the automatic-refund path (T9, PLAN §5.2/§5.6
 * failure 2, CONTEXT.md → Oversell).
 *
 * An **Oversell** is a fulfilment-time stock shortfall discovered *after*
 * capture — the deliberate consequence of holding no reservations between
 * payment-mandate verification and fulfilment. It is the third member of the
 * failure vocabulary and confusable with neither sibling: a Refusal is policy
 * saying no before money moves; a Decline is the gateway saying no before
 * money moves; an Oversell is money having *moved* and being automatically
 * sent back. Its payload shape enforces the distinction the same way
 * `DeclinePayload` does — `kind: 'oversell'`, no `recoverable` (so it can
 * never read as a Refusal), no `attempts` (so it can never read as a Decline),
 * and a `refund` block neither of the others could carry.
 */

/** One order line the fulfilment-time conditional decrement could not cover. */
export interface OversellShortfallLine {
  readonly variantId: string;
  readonly productTitle: string;
  readonly requested: number;
  /** Stock at the moment the decrement missed — reporting detail, never a guard. */
  readonly available: number;
}

/**
 * What the paid transaction stores on the Order row at detection
 * (`orders.oversell_shortfall`): the refund step reads its facts from here —
 * on the row, never rebuilt from the audit log (ADR-0003) — so a crash between
 * detection and refund loses nothing.
 */
export interface StoredOversellShortfall {
  readonly detectedAt: string;
  readonly shortfalls: readonly OversellShortfallLine[];
}

export interface OversellPayload {
  /** Fixed discriminator: never a Refusal (`recoverable` absent), never a Decline (`attempts` absent). */
  readonly kind: 'oversell';
  readonly code: 'OVERSOLD';
  readonly reason: string;
  readonly shortfalls: readonly OversellShortfallLine[];
  readonly refund: {
    readonly amountPaise: Paise;
    readonly gatewayRefundId: string;
    readonly refundedAt: string;
  };
}

/** The structured reason a refunded Order stores and reports (LLM-readable). */
export function oversellPayload(details: {
  readonly amountPaise: Paise;
  readonly gatewayRefundId: string;
  readonly refundedAt: string;
  readonly shortfalls: readonly OversellShortfallLine[];
}): OversellPayload {
  const named = details.shortfalls
    .map(
      (line) =>
        `${line.productTitle}: ${line.requested} requested, ${line.available} in stock`,
    )
    .join('; ');
  return {
    kind: 'oversell',
    code: 'OVERSOLD',
    reason:
      `The payment was captured, but the fulfilment-time stock re-check came up short ` +
      `(${named}) — no stock is reserved between verification and fulfilment, and a rival ` +
      `purchase won the remaining units. The full ${formatPaise(details.amountPaise)} was ` +
      `automatically refunded to the same payment method (gateway refund ` +
      `${details.gatewayRefundId}); nothing ships and nothing is owed. To buy again once ` +
      `stock returns, start a new purchase with a fresh Intent.`,
    shortfalls: details.shortfalls,
    refund: {
      amountPaise: details.amountPaise,
      gatewayRefundId: details.gatewayRefundId,
      refundedAt: details.refundedAt,
    },
  };
}

const parseShortfallLines = (value: unknown): readonly OversellShortfallLine[] | null => {
  if (!Array.isArray(value)) return null;
  const lines: OversellShortfallLine[] = [];
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) return null;
    const line = raw as Record<string, unknown>;
    if (
      typeof line['variantId'] !== 'string' ||
      typeof line['productTitle'] !== 'string' ||
      typeof line['requested'] !== 'number' ||
      typeof line['available'] !== 'number'
    ) {
      return null;
    }
    lines.push({
      variantId: line['variantId'],
      productTitle: line['productTitle'],
      requested: line['requested'],
      available: line['available'],
    });
  }
  return lines;
};

/**
 * Re-assert a stored `refund_reason` jsonb on its way out of the database, so
 * a view never leaks an arbitrary object where an Oversell is promised —
 * exactly `parseDeclinePayload`'s contract. Rows are written only by this
 * codebase; a mismatch is out-of-band mutation and answers null, not a lie.
 */
export function parseOversellPayload(value: unknown): OversellPayload | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record['kind'] !== 'oversell' || record['code'] !== 'OVERSOLD') return null;
  if (typeof record['reason'] !== 'string') return null;
  const shortfalls = parseShortfallLines(record['shortfalls']);
  if (shortfalls === null) return null;
  const refund = record['refund'];
  if (typeof refund !== 'object' || refund === null) return null;
  const refundRecord = refund as Record<string, unknown>;
  if (
    typeof refundRecord['amountPaise'] !== 'number' ||
    typeof refundRecord['gatewayRefundId'] !== 'string' ||
    typeof refundRecord['refundedAt'] !== 'string'
  ) {
    return null;
  }
  return {
    kind: 'oversell',
    code: 'OVERSOLD',
    reason: record['reason'],
    shortfalls,
    refund: {
      amountPaise: paise(refundRecord['amountPaise']),
      gatewayRefundId: refundRecord['gatewayRefundId'],
      refundedAt: refundRecord['refundedAt'],
    },
  };
}

/** The detection record stored on the row — same read-back discipline. */
export function parseStoredOversellShortfall(value: unknown): StoredOversellShortfall | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record['detectedAt'] !== 'string') return null;
  const shortfalls = parseShortfallLines(record['shortfalls']);
  if (shortfalls === null || shortfalls.length === 0) return null;
  return { detectedAt: record['detectedAt'], shortfalls };
}

export type OversellRefundOutcome =
  | { readonly result: 'order_refunded'; readonly orderId: string; readonly oversell: OversellPayload }
  /** The gateway would not (or could not) refund — recorded as an anomaly, Order left `paid`. */
  | { readonly result: 'refund_failed'; readonly orderId: string; readonly detail: string }
  /** The Order is not an oversold-and-paid Order — nothing to refund. */
  | { readonly result: 'not_oversold'; readonly orderId: string };

/**
 * The automatic refund for an oversold Order (PLAN §5.6 failure 2, second
 * half). Runs *after* the webhook transaction that detected the Oversell
 * committed — a refund is an external gateway call, and network calls do not
 * belong inside database transactions. Three steps, house patterns throughout:
 *
 *   1. `gateway.refund_attempted` in its own transaction, *before* the call —
 *      exactly `gateway.payment_link_attempted`'s crash-trace discipline.
 *   2. The gateway refund. A failure is recorded as `order.anomaly_detected`
 *      (`refund_failed`) and the Order stays `paid` with its shortfall on the
 *      row: fail closed means never pretending money moved back.
 *   3. One transaction for everything the refund changed: the one-way
 *      `paid → refunded` transition (guard in the WHERE clause), the stored
 *      `OversellPayload` the buyer will be told, the `order.refunded` event,
 *      and the merchant-signed refund receipt referencing the original Receipt
 *      by hash (ADR-0003: state change and audit events commit together).
 *
 * Idempotent at the gateway's expense: a second concurrent call cannot
 * double-refund because the gateway refuses a second full refund (the stub
 * enforces the same rule), and cannot double-transition because of the status
 * guard.
 */
export async function refundOversoldOrder(
  deps: StorefrontDeps,
  orderId: string,
): Promise<OversellRefundOutcome> {
  const order = await findOrderById(deps.db, deps.merchantId, orderId);
  const stored = order === null ? null : parseStoredOversellShortfall(order.oversellShortfall);
  if (order === null || order.status !== 'paid' || stored === null) {
    return { result: 'not_oversold', orderId };
  }

  const amountPaise = paise(order.amountPaise);
  const gatewayPaymentId = order.gatewayPaymentId;
  if (gatewayPaymentId === null) {
    // A paid mandate-backed Order always has one (the webhook reported it);
    // its absence means there is nothing addressable to refund against.
    const detail = 'Oversold Order has no gateway payment id to refund against';
    await deps.db.transaction(async (tx) => {
      await appendAuditEvent(tx, {
        type: 'order.anomaly_detected',
        merchantId: deps.merchantId,
        orderId,
        payload: { gateway: deps.gateway.name, reason: 'refund_failed', detail },
      });
    });
    return { result: 'refund_failed', orderId, detail };
  }

  await deps.db.transaction(async (tx) => {
    await appendAuditEvent(tx, {
      type: 'gateway.refund_attempted',
      merchantId: deps.merchantId,
      orderId,
      payload: {
        gateway: deps.gateway.name,
        gatewayPaymentId,
        amountPaise,
        shortfalls: stored.shortfalls,
      },
    });
  });

  let refund;
  try {
    refund = await deps.gateway.refundPayment({
      gatewayPaymentId,
      amountPaise,
      notes: { orderId, reason: 'oversell' },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await deps.db.transaction(async (tx) => {
      await appendAuditEvent(tx, {
        type: 'order.anomaly_detected',
        merchantId: deps.merchantId,
        orderId,
        payload: {
          gateway: deps.gateway.name,
          reason: 'refund_failed',
          gatewayPaymentId,
          amountPaise,
          detail,
        },
      });
    });
    return { result: 'refund_failed', orderId, detail };
  }

  const refundedAt = new Date();
  const oversell = oversellPayload({
    amountPaise,
    gatewayRefundId: refund.gatewayRefundId,
    refundedAt: refundedAt.toISOString(),
    shortfalls: stored.shortfalls,
  });

  return deps.db.transaction(async (tx) => {
    // `refunded` is one-way and reachable only from `paid` — the guard lives
    // in the WHERE clause (the house pattern), so a concurrent refund of the
    // same Order transitions exactly once.
    const updated = await tx
      .update(orders)
      .set({
        status: 'refunded',
        refundedAt,
        updatedAt: refundedAt,
        gatewayRefundId: refund.gatewayRefundId,
        refundReason: oversell,
      })
      .where(
        and(
          eq(orders.id, orderId),
          eq(orders.merchantId, deps.merchantId),
          eq(orders.status, 'paid'),
        ),
      )
      .returning({ id: orders.id });
    if (updated.length === 0) {
      // Unreachable when the gateway did its job (it refuses a second full
      // refund), but never assumed impossible: the loser records nothing and
      // reports rather than overwriting the winner's transition.
      return { result: 'not_oversold', orderId } as const;
    }

    await appendAuditEvent(tx, {
      type: 'order.refunded',
      merchantId: deps.merchantId,
      orderId,
      payload: {
        gateway: deps.gateway.name,
        gatewayPaymentId,
        gatewayRefundId: refund.gatewayRefundId,
        amountPaise,
        refundedAt: refundedAt.toISOString(),
        // The exact structured reason stored on the row and reported to the
        // buyer — the ledger shows what the buyer was told, not a paraphrase.
        oversell: { ...oversell },
      },
    });

    await mintRefundReceiptForOrder(tx, {
      merchantId: deps.merchantId,
      orderId,
      amountPaise,
      gatewayRefundId: refund.gatewayRefundId,
      refundedAt,
      gatewayName: deps.gateway.name,
    });

    return { result: 'order_refunded', orderId, oversell } as const;
  });
}
