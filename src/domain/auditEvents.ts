/**
 * The audit-log vocabulary (ADR-0003).
 *
 * Every entry here names a *state transition*. Each one is written in the same
 * database transaction as the state change it records, so the log is complete
 * by construction — but the system is not event-sourced: state is never rebuilt
 * from these rows.
 *
 * T1 covers the walking-skeleton path only. The trust layer (T3/T4) adds the
 * mandate, refusal and receipt events; they slot into this same union and the
 * same append-only table.
 */

export const AUDIT_EVENT_TYPES = [
  'order.created',
  'gateway.order_created',
  'gateway.payment_link_issued',
  'gateway.webhook_received',
  'order.paid',
] as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

/**
 * The canonical order a purchase's events are expected to appear in. Used to
 * describe a chain and, later, by the rule-auditor to spot a chain that skipped
 * a step. Index = position in the happy path.
 */
export const HAPPY_PATH_ORDER: readonly AuditEventType[] = AUDIT_EVENT_TYPES;

/** One-line human-readable rendering, for `GET /audit/:orderId` and the T7 viewer. */
export const AUDIT_EVENT_SUMMARIES: Record<AuditEventType, string> = {
  'order.created': 'Domain Order created from the buyer agent’s checkout call',
  'gateway.order_created': 'Gateway order created at Razorpay (test mode)',
  'gateway.payment_link_issued': 'Razorpay Payment Link issued for the human consent step',
  'gateway.webhook_received': 'Signed webhook received from Razorpay and verified',
  'order.paid': 'Domain Order marked paid',
};

export interface AuditEventRecord {
  readonly seq: number;
  readonly type: AuditEventType;
  readonly orderId: string | null;
  readonly merchantId: string;
  readonly occurredAt: Date;
  readonly payload: Record<string, unknown>;
}

export interface AuditChainEntry extends AuditEventRecord {
  readonly summary: string;
}

/**
 * Put a set of audit rows into their canonical order and attach summaries.
 *
 * Ordering is by `seq` — the append-only table's monotonic sequence — and never
 * by timestamp, because two events written inside one transaction share a
 * commit time and would otherwise sort arbitrarily.
 */
export function toAuditChain(events: readonly AuditEventRecord[]): AuditChainEntry[] {
  return [...events]
    .sort((a, b) => a.seq - b.seq)
    .map((event) => ({ ...event, summary: AUDIT_EVENT_SUMMARIES[event.type] }));
}

/**
 * Which happy-path transitions this chain is still missing, in order. An empty
 * array means the purchase completed. Deliberately tolerant of extra or
 * repeated events (a Razorpay webhook can be redelivered).
 */
export function missingHappyPathSteps(
  events: readonly AuditEventRecord[],
): readonly AuditEventType[] {
  const seen = new Set(events.map((e) => e.type));
  return HAPPY_PATH_ORDER.filter((type) => !seen.has(type));
}
