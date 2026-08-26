import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { runSdkBuyerPurchase, SdkBuyerError } from '../../buyer/sdkBuyer.js';
import { LocalSigner } from '../../buyer/localSigner.js';
import { generateSigningKeypair } from '../../domain/keys.js';
import { normalizeBaseUrl } from '../../config.js';
import type {
  BuyerDecider,
  LiveEvalTask,
  LiveRunOutcome,
  LiveRunResult,
  LiveSuiteRun,
  PaymentApprover,
} from './types.js';

/**
 * Orchestration for one live-eval invocation. Deliberately free of both
 * non-deterministic actors (see types.ts): given a decider and an approver it
 * runs each task end to end over a real Streamable HTTP MCP connection — the
 * exact transport the deployed endpoint serves — with a fresh client-custody
 * keypair per run (ADR-0004: the private key never leaves the LocalSigner).
 */

/** Thrown by an approver to end a --dry-run cleanly after link issuance. */
export class DryRunStop extends Error {
  constructor() {
    super('dry run: stopping before the payment page');
    this.name = 'DryRunStop';
  }
}

export interface LiveRunnerDeps {
  readonly decide: BuyerDecider;
  readonly approvePayment: PaymentApprover;
  /** get_order_status polling; live runs want a couple of minutes of patience. */
  readonly pollIntervalMs?: number;
  readonly maxPolls?: number;
  /** Progress lines; defaults to silence (tests) — the CLI passes console.log. */
  readonly log?: (line: string) => void;
}

const refusalOutcome = (error: SdkBuyerError): LiveRunOutcome => {
  const refusal = error.body['refusal'] as Record<string, unknown> | undefined;
  if (refusal && typeof refusal['code'] === 'string') {
    return {
      kind: 'refused',
      tool: error.tool,
      code: refusal['code'],
      reason: typeof refusal['reason'] === 'string' ? refusal['reason'] : '',
    };
  }
  const validation = error.body['validationError'] as Record<string, unknown> | undefined;
  if (validation && typeof validation['code'] === 'string') {
    return {
      kind: 'refused',
      tool: error.tool,
      code: validation['code'],
      reason: typeof validation['message'] === 'string' ? validation['message'] : '',
    };
  }
  return { kind: 'error', message: error.message };
};

/** Run one task against `target` (the deployment's base URL, no trailing /). */
export async function runLiveEvalTask(
  target: string,
  task: LiveEvalTask,
  deps: LiveRunnerDeps,
): Promise<LiveRunResult> {
  const base = normalizeBaseUrl(target);
  const mcpUrl = `${base}/mcp`;
  const log = deps.log ?? (() => {});
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const transcript: string[] = [];
  let costUsd: number | null = null;

  const finish = (
    decision: LiveRunResult['decision'],
    outcome: LiveRunOutcome,
  ): LiveRunResult => ({
    task,
    decision,
    outcome,
    transcript,
    startedAt,
    durationMs: Date.now() - startedMs,
    costUsd,
  });

  log(`[${task.id}] deciding: ${task.instruction}`);
  let decided;
  try {
    decided = await deps.decide(task, { mcpUrl });
  } catch (error) {
    return finish(null, {
      kind: 'error',
      message: `decider failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  transcript.push(...decided.transcript);
  costUsd = decided.costUsd;
  const decision = decided.decision;

  if (decision.action === 'walk_away') {
    log(`[${task.id}] buyer walked away: ${decision.reasoning}`);
    return finish(decision, { kind: 'walked_away', reasoning: decision.reasoning });
  }

  log(`[${task.id}] buying ${JSON.stringify(decision.items)} within ₹${decision.budgetPaise / 100}`);
  const client = new Client({ name: 'agent-store-live-eval', version: '0.1.0' });
  let issuedOrderId: string | null = null;
  let issuedLinkUrl: string | null = null;
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl)));
    // A fresh keypair per run: each live run is its own Agent, so caps and
    // mandate chains from one run can never leak into the next.
    const signer = new LocalSigner(generateSigningKeypair());
    const purchase = await runSdkBuyerPurchase(client, signer, {
      capPaise: task.capPaise,
      want: decision.want,
      budgetPaise: decision.budgetPaise,
      items: decision.items,
      approvePayment: async (payment) => {
        issuedOrderId = payment.orderId;
        issuedLinkUrl = payment.paymentLinkUrl;
        transcript.push(
          `payment link issued for Order ${payment.orderId}: ${payment.paymentLinkUrl}`,
        );
        log(`[${task.id}] payment link issued: ${payment.paymentLinkUrl}`);
        await deps.approvePayment(payment);
      },
      ...(deps.pollIntervalMs !== undefined ? { pollIntervalMs: deps.pollIntervalMs } : {}),
      ...(deps.maxPolls !== undefined ? { maxPolls: deps.maxPolls } : {}),
    });
    transcript.push(`Receipt verified locally against the mandate chain (Order ${purchase.orderId})`);
    log(`[${task.id}] paid — Order ${purchase.orderId}`);
    return finish(decision, {
      kind: 'paid',
      orderId: purchase.orderId,
      auditUrl: `${base}/audit/${purchase.orderId}`,
      receiptVerified: true,
    });
  } catch (error) {
    if (error instanceof DryRunStop && issuedOrderId !== null && issuedLinkUrl !== null) {
      log(`[${task.id}] dry run stopped before payment`);
      return finish(decision, {
        kind: 'dry_run_stopped',
        orderId: issuedOrderId,
        paymentLinkUrl: issuedLinkUrl,
        auditUrl: `${base}/audit/${issuedOrderId}`,
      });
    }
    if (error instanceof SdkBuyerError) {
      const outcome = refusalOutcome(error);
      if (outcome.kind === 'refused') {
        log(`[${task.id}] refused at ${outcome.tool}: ${outcome.code}`);
      }
      return finish(decision, outcome);
    }
    return finish(decision, {
      kind: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await client.close().catch(() => {});
  }
}

/** Run every task in order (sequentially — live rails, one purchase at a time). */
export async function runLiveEvalSuite(
  target: string,
  tasks: readonly LiveEvalTask[],
  deps: LiveRunnerDeps,
  options: { readonly dryRun?: boolean } = {},
): Promise<LiveSuiteRun> {
  const startedAt = new Date().toISOString();
  const results: LiveRunResult[] = [];
  for (const task of tasks) {
    results.push(await runLiveEvalTask(target, task, deps));
  }
  return {
    target: normalizeBaseUrl(target),
    startedAt,
    dryRun: options.dryRun ?? false,
    results,
  };
}
