/**
 * The scripted protocol eval suite (T15, PLAN §6): 30 deterministic scenarios
 * driven through the storefront's two protocol faces — the MCP tools and the
 * ACP-flavored REST endpoints — against the StubGateway on an embedded PGlite
 * Postgres. One command, zero network, zero credentials, CI-runnable; the
 * live suite (src/evals/live) is its non-deterministic sibling and is
 * reported separately.
 *
 * Design mirrors the live suite's: types here, the drivers and world in their
 * own modules, the runner orchestrating, a CLI on top. What is different is
 * the contract — every scenario states its expected outcome and *fails* when
 * the protocol does not deliver it, and the whole batch's audit log is handed
 * to the rule-auditor afterwards (src/evals/protocol/ruleAuditor.ts).
 */

/** Which protocol door a scenario walks through (CONTEXT.md → Face). */
export type Face = 'mcp' | 'rest' | 'both';

export type ScenarioCategory =
  | 'happy path'
  | 'refusals'
  | 'idempotency & replay'
  | 'invalid mandates'
  | 'validation errors'
  | 'gateway failures';

/**
 * One audit_events row as the suite exports it — everything the rule-auditor
 * is allowed to see, and nothing else (PLAN §6: the auditor reads only the
 * audit log; app state and scenario results are out of bounds).
 */
export interface AuditLogRecord {
  readonly seq: number;
  readonly type: string;
  readonly orderId: string | null;
  readonly merchantId: string;
  readonly payload: Record<string, unknown>;
  /** Which scenario's world wrote the row — provenance, never used by asserts. */
  readonly scenarioId: string;
}

/** A scenario assertion that did not hold. Carries the reason verbatim. */
export class ScenarioFailure extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'ScenarioFailure';
  }
}

export interface ScenarioResult {
  readonly id: string;
  readonly name: string;
  readonly face: Face;
  readonly category: ScenarioCategory;
  readonly expected: string;
  readonly passed: boolean;
  /** Why it failed — null when it passed. */
  readonly reason: string | null;
  readonly durationMs: number;
}

export interface ProtocolSuiteRun {
  readonly startedAt: string;
  readonly results: readonly ScenarioResult[];
  /**
   * Wall-clock duration of every successful `submit_payment` that produced an
   * Order — the checkout step: full mandate-chain verification, Order +
   * Payment-mandate persistence, and the (stub) payment-link call. Refused
   * submissions are excluded: a Refusal is not a checkout.
   */
  readonly checkoutLatenciesMs: readonly number[];
  /** The whole batch's audit log, in write order, for the rule-auditor. */
  readonly auditLog: readonly AuditLogRecord[];
}
