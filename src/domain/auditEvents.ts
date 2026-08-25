/**
 * The audit-log vocabulary (ADR-0003).
 *
 * Every entry here names a *state transition* or an *attempt at one*. Each is
 * written in the same database transaction as the state change it records, so
 * the log is complete by construction — but the system is not event-sourced:
 * state is never rebuilt from these rows.
 *
 * T1 covers the walking-skeleton path only. The trust layer (T3/T4) adds the
 * mandate, refusal and receipt events; they slot into this same union and the
 * same append-only table.
 *
 * **Naming rule.** These are *our* event names. A gateway's own event names are
 * never written here bare: they are namespaced (`razorpay:order.paid`) wherever
 * they appear in a payload, because Razorpay also has an event spelled
 * `order.paid` and the rule-auditor must never meet two meanings of one
 * spelling. See `namespaceGatewayEvent`.
 */

export const AUDIT_EVENT_TYPES = [
  'order.created',
  /** Written *before* the external call, so a crash mid-call leaves a trace. */
  'gateway.payment_link_attempted',
  'gateway.payment_link_issued',
  'gateway.webhook_received',
  /** The real gateway order id, learned from the webhook — never at checkout. */
  'gateway.order_linked',
  'order.paid',
  /** Something arrived that we refused to act on. Never silently swallowed. */
  'order.anomaly_detected',
  // T3 — the trust layer's own transitions:
  /** An Agent was minted: custodial keypair + token + Cap (ADR-0001). */
  'agent.registered',
  /**
   * The trust layer said no *before money moved*. The structured Refusal —
   * `{code, reason, recoverable}` — is the payload, so "every refusal has a
   * reason code" is checkable from this table alone.
   */
  'agent.refused',
  // T4 — the mandate chain's own transitions (appended, so the pg enum grows
  // by ALTER TYPE … ADD VALUE instead of a rebuild):
  /** An Intent mandate was declared: Agent-signed want + Budget stored. */
  'mandate.intent_declared',
  /** A Cart mandate was created: immutable, both-sides-signed items + total + price hash. */
  'mandate.cart_created',
  /** The full mandate chain verified — the trust gate passed, money may now move. */
  'payment.verified',
  /** The trust gate refused a Payment mandate. Same Refusal payload shape as `agent.refused`. */
  'payment.refused',
  /** Merchant-signed Receipt minted for the paid Order, in the same tx as `order.paid`. */
  'receipt.issued',
] as const;

export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

/**
 * The transitions a completed purchase must show — since T4, the mandate-first
 * path: chain declared and verified before the Order, Receipt after payment.
 * `gateway.order_linked` is absent on purpose: Razorpay attaches a gateway
 * order to a Payment Link, but whether its id reaches us depends on which
 * webhook event fired, so requiring it would make a perfectly good purchase
 * look incomplete.
 *
 * Pre-T4 paid Orders (real rows exist in the deployed DB) report
 * `complete: false` at `/audit/:orderId` under this list. Deliberate and
 * honest: they had no mandate chain, and the auditor should say so rather
 * than grandfather them in.
 */
export const REQUIRED_HAPPY_PATH: readonly AuditEventType[] = [
  'mandate.intent_declared',
  'mandate.cart_created',
  'payment.verified',
  'order.created',
  'gateway.payment_link_attempted',
  'gateway.payment_link_issued',
  'gateway.webhook_received',
  'order.paid',
  'receipt.issued',
];

/** One-line human-readable rendering, for `GET /audit/:orderId` and the T7 viewer. */
export const AUDIT_EVENT_SUMMARIES: Record<AuditEventType, string> = {
  'order.created': 'Domain Order created from the buyer agent’s checkout call',
  'gateway.payment_link_attempted': 'About to ask Razorpay for a Payment Link',
  'gateway.payment_link_issued':
    'Razorpay Payment Link issued for the human consent step',
  'gateway.webhook_received': 'Signed webhook received from Razorpay and verified',
  'gateway.order_linked': 'Razorpay’s own gateway order id recorded against this Order',
  'order.paid': 'Domain Order marked paid',
  'order.anomaly_detected': 'Anomaly detected — the Order was deliberately not advanced',
  'agent.registered': 'Agent registered — custodial keypair minted, Cap declared',
  'agent.refused': 'Refused by the trust layer before any money moved — reason code in payload',
  'mandate.intent_declared': 'Intent mandate declared — Agent-signed want and Budget recorded',
  'mandate.cart_created':
    'Cart mandate created — immutable snapshot of items, total and price hash, signed by both sides',
  'payment.verified': 'Payment mandate verified — mandate chain checked, cleared to contact the gateway',
  'payment.refused': 'Payment mandate refused before any money moved — reason code in payload',
  'receipt.issued': 'Merchant-signed Receipt issued for the paid Order',
};

/**
 * Reasons an `order.anomaly_detected` event is written. Each one means "we saw
 * something we could not safely act on", and in every case the Order is left
 * exactly as it was.
 */
export type AnomalyReason =
  /** Webhook amount ≠ the Order's amount. Never mark such an Order paid. */
  | 'amount_mismatch'
  /** A success webhook carried no amount, so the amount could not be checked. */
  | 'amount_missing'
  /** A second, different gateway order id for an Order that already has one. */
  | 'gateway_order_id_conflict'
  /** More than one Order matched a webhook. */
  | 'ambiguous_webhook_match'
  /**
   * A mandate-backed Order was paid but the merchant has no signing key, so no
   * Receipt could be minted. The paid transition stands; the missing proof is
   * recorded instead of thrown — a webhook redelivery would fix nothing.
   */
  | 'missing_merchant_signing_key';

/**
 * Qualify a gateway's raw event name so it can never collide with one of ours.
 * `razorpay:order.paid` (theirs) vs `order.paid` (ours).
 */
export function namespaceGatewayEvent(gatewayName: string, rawEvent: string): string {
  return `${gatewayName}:${rawEvent}`;
}

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
 * Which required transitions this chain is still missing, in order. An empty
 * array means the purchase completed. Deliberately tolerant of extra or
 * repeated events (a Razorpay webhook can be redelivered).
 */
export function missingHappyPathSteps(
  events: readonly AuditEventRecord[],
): readonly AuditEventType[] {
  const seen = new Set(events.map((e) => e.type));
  return REQUIRED_HAPPY_PATH.filter((type) => !seen.has(type));
}
