import type { PaymentLinkView } from '../../buyer/sdkBuyer.js';

/**
 * The live eval suite (T16, PLAN §6): 3–5 REAL Claude-as-buyer runs against a
 * DEPLOYED endpoint on real test rails. Everything in this directory is the
 * harness; the runs themselves are triggered by a human (Max quota, real
 * rails, real non-determinism — see docs/live-evals.md).
 *
 * The seam design mirrors the rest of the codebase: the two non-deterministic
 * actors — the LLM that decides what to buy, and the payer-bot that approves
 * the hosted Payment Link — are injected. CI exercises the whole orchestration
 * with a canned decider and a stub-gateway approver; the real runs swap in the
 * Claude Agent SDK decider and the Playwright payer-bot without touching the
 * runner.
 */

/** One natural-language buying task handed to the Claude buyer. */
export interface LiveEvalTask {
  readonly id: string;
  /** The instruction the buyer agent receives, in natural language. */
  readonly instruction: string;
  /** Cap declared at registration for this run, integer paise. */
  readonly capPaise: number;
  /**
   * What a good outcome looks like, for the human reading the report. The
   * suite never asserts on this — live runs are observations, not test cases.
   */
  readonly expectation: string;
}

/** What the buyer decided to do with the task, after seeing the catalog. */
export type BuyerDecision =
  | {
      readonly action: 'buy';
      /** The Intent's `want`, in the buyer's own words. */
      readonly want: string;
      /** Budget for the Intent, integer paise. Must be ≤ the task's cap. */
      readonly budgetPaise: number;
      readonly items: ReadonlyArray<{
        readonly variantId: string;
        readonly quantity: number;
      }>;
      readonly reasoning: string;
    }
  | {
      /** The buyer judged the task impossible and never opened a mandate chain. */
      readonly action: 'walk_away';
      readonly reasoning: string;
    };

/** The decider's answer plus everything worth keeping about how it got there. */
export interface DeciderResult {
  readonly decision: BuyerDecision;
  /** Human-readable trace of the decision loop (tool calls, model text). */
  readonly transcript: readonly string[];
  /** Agent SDK cost estimate for this decision, when one exists. */
  readonly costUsd: number | null;
}

/**
 * Injected seam #1: the shopping brain. The real implementation asks Claude
 * (Agent SDK, Max auth) after it has inspected the live catalog over the same
 * MCP endpoint; CI injects a canned one.
 */
export type BuyerDecider = (
  task: LiveEvalTask,
  context: { readonly mcpUrl: string },
) => Promise<DeciderResult>;

/**
 * Injected seam #2: the consent step. The real implementation is the
 * Playwright payer-bot driving the Razorpay-hosted link; CI completes the
 * payment on the stub gateway and posts the synthetic webhooks. Throwing
 * `DryRunStop` aborts the run cleanly after the Payment Link is issued.
 */
export type PaymentApprover = (payment: PaymentLinkView) => Promise<void>;

/** How one run ended. Exactly one of these per task. */
export type LiveRunOutcome =
  | {
      readonly kind: 'paid';
      readonly orderId: string;
      /** The audit chain for this purchase, on the target deployment. */
      readonly auditUrl: string;
      /** The buyer verified the merchant-signed Receipt locally. */
      readonly receiptVerified: true;
    }
  | {
      /** The server refused inside the protocol — a first-class outcome. */
      readonly kind: 'refused';
      readonly tool: string;
      readonly code: string;
      readonly reason: string;
    }
  | {
      /** The buyer decided not to attempt a purchase at all. */
      readonly kind: 'walked_away';
      readonly reasoning: string;
    }
  | {
      /** --dry-run: stopped after the Payment Link was issued, before paying. */
      readonly kind: 'dry_run_stopped';
      readonly orderId: string;
      readonly paymentLinkUrl: string;
      readonly auditUrl: string;
    }
  | {
      /** Anything else: transport failure, unparseable decision, timeout… */
      readonly kind: 'error';
      readonly message: string;
    };

/** Everything recorded about one run. */
export interface LiveRunResult {
  readonly task: LiveEvalTask;
  readonly decision: BuyerDecision | null;
  readonly outcome: LiveRunOutcome;
  readonly transcript: readonly string[];
  readonly startedAt: string;
  readonly durationMs: number;
  readonly costUsd: number | null;
}

/** One suite invocation: the input to the report writer. */
export interface LiveSuiteRun {
  readonly target: string;
  readonly startedAt: string;
  readonly dryRun: boolean;
  readonly results: readonly LiveRunResult[];
}
