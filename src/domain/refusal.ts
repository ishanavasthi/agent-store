/**
 * The failure vocabulary, kept strictly separate (CONTEXT.md → Failure vocabulary).
 *
 * Three different things must never share a type, because the rule-auditor's
 * guarantees are about exactly one of them:
 *
 *   - **Refusal** — the trust layer saying no, *on policy*, before money moves.
 *     Always `{code, reason, recoverable, retryAfter?}`. This is the only one
 *     the rule-auditor reasons about.
 *   - **Decline** — the gateway saying no *after* the trust layer said yes.
 *     Never a Refusal. Lives on the webhook path, not here.
 *   - **Validation error** — malformed input, a schema violation, a reference to
 *     something that does not exist. Neither of the above.
 */

/**
 * T1 enforces only the pre-payment stock case, which CONTEXT.md names as *the*
 * refusal case ("out-of-stock — that's the pre-payment refusal case"). The
 * trust layer (T3/T4/T5) adds the rest of this union; they are listed in one
 * place so the vocabulary is fixed rather than accreting per ticket.
 */
export type RefusalCode =
  | 'OUT_OF_STOCK'
  /** T3: the token presented matches no Agent registration (ADR-0001). */
  | 'UNREGISTERED_AGENT'
  /** T5: cart total exceeds the Intent's Budget. Recoverable — a smaller cart under the same Intent can pass. */
  | 'OVER_BUDGET'
  /** T5: cumulative captured+pending spend would exceed the registration's immutable Cap. Not recoverable. */
  | 'OVER_CAP'
  /** T5: idempotency key reused with a *different* cart hash. Recoverable — mint a fresh key. (Same hash replays instead.) */
  | 'IDEMPOTENCY_REUSE'
  /** T5: this Intent was already consumed at submission by the first Cart mandate to pass the trust gate (1:1:1). Recoverable — declare a new Intent. */
  | 'INTENT_CONSUMED'
  /** T4: the pinned price hash no longer matches the live catalog. Recoverable — re-run create_cart. */
  | 'PRICE_CHANGED'
  /** T4: a stored mandate fails signature, chain-hash, or total verification. Not recoverable. */
  | 'INVALID_MANDATE';

export interface RefusalPayload {
  readonly code: RefusalCode;
  readonly reason: string;
  /** Whether the Agent can do something and try again. */
  readonly recoverable: boolean;
  /** Seconds to wait before a retry could succeed. Omitted when never. */
  readonly retryAfter?: number;
}

/**
 * Thrown when policy says no before money moves. Carries the structured payload
 * an LLM buyer recovers from — never bare prose.
 */
export class Refusal extends Error {
  readonly code: RefusalCode;
  readonly reason: string;
  readonly recoverable: boolean;
  readonly retryAfter: number | undefined;

  constructor(payload: RefusalPayload) {
    super(`${payload.code}: ${payload.reason}`);
    this.name = 'Refusal';
    this.code = payload.code;
    this.reason = payload.reason;
    this.recoverable = payload.recoverable;
    this.retryAfter = payload.retryAfter;
  }

  toPayload(): RefusalPayload {
    return {
      code: this.code,
      reason: this.reason,
      recoverable: this.recoverable,
      ...(this.retryAfter === undefined ? {} : { retryAfter: this.retryAfter }),
    };
  }
}

export type ValidationErrorCode =
  | 'INVALID_QUANTITY'
  | 'VARIANT_NOT_FOUND'
  | 'ORDER_NOT_FOUND'
  /** A Cap that is not a positive integer number of paise (CONTEXT.md → Money). */
  | 'INVALID_CAP'
  /** A Budget that is not a positive integer number of paise — Cap's per-Intent sibling. */
  | 'INVALID_BUDGET'
  /** An Intent whose `want` is empty — a signed Intent must state an intent. */
  | 'INVALID_WANT'
  /** A Cart item list that is malformed as a *list* (empty, duplicate Variants). */
  | 'INVALID_CART_ITEMS'
  // A reference to a mandate hash that names nothing is malformed input, like
  // VARIANT_NOT_FOUND — a mandate that EXISTS but fails signature or chain
  // verification is policy, and refuses with INVALID_MANDATE instead.
  | 'INTENT_NOT_FOUND'
  | 'CART_NOT_FOUND';

/**
 * A malformed or unsatisfiable request. Deliberately a *different shape* from
 * `RefusalPayload` — no `recoverable`, no `retryAfter` — so that neither the
 * rule-auditor nor a buyer agent can mistake one category for the other.
 */
export interface ValidationErrorPayload {
  readonly code: ValidationErrorCode;
  readonly message: string;
}

export class ValidationError extends Error {
  readonly code: ValidationErrorCode;

  constructor(code: ValidationErrorCode, message: string) {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
  }

  toPayload(): ValidationErrorPayload {
    return { code: this.code, message: this.message };
  }
}
