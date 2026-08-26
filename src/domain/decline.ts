/**
 * The Decline vocabulary (CONTEXT.md → Failure vocabulary).
 *
 * A **Decline** is the payment gateway saying no *after* the trust layer said
 * yes — it lives on the webhook path, downstream of `payment.verified`, and is
 * never a Refusal. It gets its own file and its own shape precisely so the two
 * can never be confused: a `RefusalPayload` carries `recoverable` and belongs
 * to policy; a `DeclinePayload` carries `attempts` and belongs to the gateway.
 * The rule-auditor's guarantees are about Refusals and never about this type.
 *
 * T8 (PLAN §5.6, failure 1): a declined payment is retryable exactly once on
 * the same hosted link. The *gateway* allows unlimited retries; the bound is
 * ours, enforced here — the second distinct failed attempt fails the Order
 * closed: `cancelled`, with this structured reason stored on the row, zero
 * charge, and the buyer told a Decline (never a Refusal) at get_order_status.
 */

/**
 * How many distinct failed payment attempts one Order tolerates before it
 * fails closed: the original attempt plus exactly one bounded retry.
 */
export const PAYMENT_ATTEMPT_LIMIT = 2;

export interface DeclinePayload {
  /** Fixed discriminator so a wire consumer can never read this as a Refusal. */
  readonly kind: 'decline';
  readonly code: 'PAYMENT_DECLINED';
  readonly reason: string;
  /** Distinct failed payment attempts counted against PAYMENT_ATTEMPT_LIMIT. */
  readonly attempts: number;
  /** The gateway's own error code for the final attempt, when it sent one. */
  readonly gatewayErrorCode: string | null;
  /** The gateway's own description for the final attempt, when it sent one. */
  readonly gatewayErrorDescription: string | null;
}

/** The structured reason a fail-closed cancellation stores and reports. */
export function declinePayload(details: {
  readonly attempts: number;
  readonly gatewayErrorCode: string | null;
  readonly gatewayErrorDescription: string | null;
}): DeclinePayload {
  return {
    kind: 'decline',
    code: 'PAYMENT_DECLINED',
    reason:
      `The payment gateway declined ${details.attempts} attempts — the original and ` +
      `${details.attempts - 1} bounded ${details.attempts === 2 ? 'retry' : 'retries'}. ` +
      'The Order failed closed: cancelled, nothing was charged. ' +
      'To buy this again, start a new purchase with a fresh Intent.',
    attempts: details.attempts,
    gatewayErrorCode: details.gatewayErrorCode,
    gatewayErrorDescription: details.gatewayErrorDescription,
  };
}

/**
 * Re-assert a stored `cancellation_reason` jsonb on its way out of the
 * database, so a view never leaks an arbitrary object where a Decline is
 * promised. Rows are written only by this codebase; a mismatch is out-of-band
 * mutation and answers null rather than a lie.
 */
export function parseDeclinePayload(value: unknown): DeclinePayload | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record['kind'] !== 'decline' || record['code'] !== 'PAYMENT_DECLINED') return null;
  if (typeof record['reason'] !== 'string' || typeof record['attempts'] !== 'number') return null;
  const gatewayErrorCode = record['gatewayErrorCode'];
  const gatewayErrorDescription = record['gatewayErrorDescription'];
  if (gatewayErrorCode !== null && typeof gatewayErrorCode !== 'string') return null;
  if (gatewayErrorDescription !== null && typeof gatewayErrorDescription !== 'string') return null;
  return {
    kind: 'decline',
    code: 'PAYMENT_DECLINED',
    reason: record['reason'],
    attempts: record['attempts'],
    gatewayErrorCode,
    gatewayErrorDescription,
  };
}
