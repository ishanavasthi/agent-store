import path from 'node:path';
import process from 'node:process';
import { claudeDecider } from './claudeDecider.js';
import { approvePaymentLink } from './payerBot.js';
import { writeLiveReport } from './report.js';
import { DryRunStop, runLiveEvalSuite } from './runner.js';
import { DEFAULT_LIVE_TASKS } from './tasks.js';

/**
 * `npm run evals:live` — the live suite's entry point (T16, PLAN §6).
 *
 * REAL RUNS ARE HUMAN-TRIGGERED. This command spends Max-subscription model
 * quota, drives real Razorpay test rails, and is non-deterministic end to
 * end; CI must only ever run it with `--dry-run` (or not at all — the vitest
 * suite covers the orchestration against the local app + stub gateway).
 *
 *   npm run evals:live -- --target https://<deployment>        # real runs
 *   npm run evals:live -- --dry-run                            # stop before paying
 *   npm run evals:live -- --task black-tee-under-1500          # subset
 *   npm run evals:live -- --headed                             # watch the payer-bot
 *
 * Target resolution: --target flag, else LIVE_EVAL_TARGET, else
 * PUBLIC_BASE_URL (the deployed URL the server itself is configured with).
 */

interface CliArgs {
  readonly target: string;
  readonly dryRun: boolean;
  readonly headed: boolean;
  readonly taskIds: readonly string[];
  readonly outDir: string;
}

function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv): CliArgs {
  let target = env['LIVE_EVAL_TARGET'] ?? env['PUBLIC_BASE_URL'] ?? '';
  let dryRun = false;
  let headed = false;
  let outDir = 'evals';
  const taskIds: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };
    if (arg === '--target') target = next();
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--headed') headed = true;
    else if (arg === '--task') taskIds.push(next());
    else if (arg === '--out') outDir = next();
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (target === '') {
    throw new Error(
      'No target. Pass --target https://<deployment>, or set LIVE_EVAL_TARGET or PUBLIC_BASE_URL.',
    );
  }
  return { target, dryRun, headed, taskIds, outDir };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), process.env);
  const tasks =
    args.taskIds.length === 0
      ? DEFAULT_LIVE_TASKS
      : args.taskIds.map((id) => {
          const task = DEFAULT_LIVE_TASKS.find((t) => t.id === id);
          if (task === undefined) {
            throw new Error(
              `unknown task '${id}' — known: ${DEFAULT_LIVE_TASKS.map((t) => t.id).join(', ')}`,
            );
          }
          return task;
        });

  console.log(`[live-evals] target ${args.target}`);
  console.log(`[live-evals] mode   ${args.dryRun ? 'DRY RUN (stops before the payment page)' : 'LIVE test rails'}`);
  console.log(`[live-evals] tasks  ${tasks.map((t) => t.id).join(', ')}`);

  const run = await runLiveEvalSuite(
    args.target,
    tasks,
    {
      decide: claudeDecider({ log: console.log }),
      approvePayment: async (payment, { record }) => {
        // Every payer-bot line goes to BOTH the terminal and the run's
        // transcript — the step log is the only thing that makes a selector
        // failure fixable, and a terminal is not evidence.
        const log = (line: string): void => {
          console.log(line);
          record(line.trim());
        };
        if (args.dryRun) {
          // Validate what the payer-bot would receive, then stop cleanly.
          await approvePaymentLink(payment.paymentLinkUrl, { dryRun: true, log });
          throw new DryRunStop();
        }
        await approvePaymentLink(payment.paymentLinkUrl, {
          headless: !args.headed,
          log,
          artifactDir: path.resolve(args.outDir, 'live-runs', 'artifacts'),
          artifactPrefix: payment.orderId,
        });
      },
      // Real rails: Razorpay settles test-mode UPI within seconds, but the
      // webhooks ride the public internet — give them up to three minutes.
      pollIntervalMs: 3_000,
      maxPolls: 60,
      log: console.log,
    },
    { dryRun: args.dryRun },
  );

  const written = await writeLiveReport(path.resolve(args.outDir), run);
  console.log(`[live-evals] report ${written.reportPath}`);
  console.log(`[live-evals] raw    ${written.rawPath}`);

  for (const result of run.results) {
    console.log(`[live-evals] ${result.task.id}: ${result.outcome.kind}`);
  }
  if (run.results.some((r) => r.outcome.kind === 'error')) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error('[live-evals] failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
