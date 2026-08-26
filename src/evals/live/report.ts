import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { LiveRunOutcome, LiveRunResult, LiveSuiteRun } from './types.js';

/**
 * The live-suite report writer. Deliberately a SEPARATE artifact from the
 * scripted suite's scoreboard (PLAN §6): these runs ride a real LLM and real
 * test rails, so their outcomes are observations of one run each — not pass
 * rates, and never reproducible on command. The report says so, loudly, so
 * nobody reads a 3-for-3 as a benchmark.
 */

const outcomeCell = (outcome: LiveRunOutcome): string => {
  switch (outcome.kind) {
    case 'paid':
      return `PAID — Order \`${outcome.orderId}\`, Receipt verified locally`;
    case 'refused':
      return `REFUSED — \`${outcome.code}\` at \`${outcome.tool}\``;
    case 'walked_away':
      return 'WALKED AWAY — buyer declined to attempt';
    case 'dry_run_stopped':
      return `DRY RUN — stopped after link issuance, Order \`${outcome.orderId}\` left pending`;
    case 'error':
      return `ERROR — ${outcome.message}`;
  }
};

const money = (paise: number): string => `₹${(paise / 100).toFixed(2)}`;

function renderRun(result: LiveRunResult, index: number): string {
  const lines: string[] = [];
  const { task, decision, outcome } = result;
  lines.push(`### Run ${index + 1}: ${task.id}`);
  lines.push('');
  lines.push(`- **Task:** ${task.instruction}`);
  lines.push(`- **Cap:** ${money(task.capPaise)} · **Expectation:** ${task.expectation}`);
  if (decision !== null) {
    if (decision.action === 'buy') {
      const items = decision.items
        .map((item) => `${item.quantity}× \`${item.variantId}\``)
        .join(', ');
      lines.push(`- **Decision:** buy ${items} within ${money(decision.budgetPaise)}`);
    } else {
      lines.push(`- **Decision:** walk away`);
    }
    lines.push(`- **Buyer's reasoning:** ${decision.reasoning}`);
  } else {
    lines.push(`- **Decision:** none (the decider itself failed)`);
  }
  lines.push(`- **Outcome:** ${outcomeCell(outcome)}`);
  if (outcome.kind === 'paid' || outcome.kind === 'dry_run_stopped') {
    lines.push(`- **Audit chain:** ${outcome.auditUrl}`);
  }
  lines.push(
    `- **Started:** ${result.startedAt} · **Duration:** ${(result.durationMs / 1000).toFixed(1)}s` +
      (result.costUsd !== null ? ` · **Model cost (est.):** $${result.costUsd.toFixed(4)}` : ''),
  );
  if (result.transcript.length > 0) {
    lines.push('');
    lines.push('<details><summary>Transcript</summary>');
    lines.push('');
    lines.push('```');
    lines.push(...result.transcript);
    lines.push('```');
    lines.push('');
    lines.push('</details>');
  }
  lines.push('');
  return lines.join('\n');
}

/** Render the whole report as Markdown. */
export function renderLiveReport(run: LiveSuiteRun): string {
  const counts = new Map<LiveRunOutcome['kind'], number>();
  for (const result of run.results) {
    counts.set(result.outcome.kind, (counts.get(result.outcome.kind) ?? 0) + 1);
  }
  const summary = [...counts.entries()].map(([kind, n]) => `${n} ${kind}`).join(' · ');

  const lines: string[] = [
    '# Live eval report',
    '',
    '> **Non-deterministic by nature.** These are real Claude-as-buyer runs (Agent SDK)',
    '> against a deployed endpoint on real Razorpay test rails, with a Playwright',
    '> payer-bot approving the hosted Payment Link. Each run is a one-off observation:',
    '> rerunning produces different transcripts and can produce different outcomes.',
    '> This report is **separate from the scripted suite\'s deterministic scoreboard**',
    '> and its counts must never be read as a benchmark or pass rate (PLAN §6).',
    '',
    `- **Target:** ${run.target}`,
    `- **Started:** ${run.startedAt}`,
    `- **Mode:** ${run.dryRun ? 'DRY RUN — no payment page was ever driven; no money-moving step ran' : 'live test rails'}`,
    `- **Runs:** ${run.results.length} (${summary || 'none'})`,
    '',
    '## Runs',
    '',
  ];
  run.results.forEach((result, index) => {
    lines.push(renderRun(result, index));
  });
  return lines.join('\n');
}

export interface WrittenReport {
  readonly reportPath: string;
  readonly rawPath: string;
}

/**
 * Write the Markdown report to `<dir>/live-report.md` (the stable, linkable
 * location) and the raw run data — transcripts included — beside it under
 * `<dir>/live-runs/`, timestamped so successive invocations never clobber
 * their evidence.
 */
export async function writeLiveReport(dir: string, run: LiveSuiteRun): Promise<WrittenReport> {
  const runsDir = path.join(dir, 'live-runs');
  await mkdir(runsDir, { recursive: true });
  const reportPath = path.join(dir, 'live-report.md');
  const stamp = run.startedAt.replaceAll(':', '-').replace(/\.\d+Z$/, 'Z');
  const rawPath = path.join(runsDir, `${stamp}${run.dryRun ? '-dry-run' : ''}.json`);
  await writeFile(reportPath, renderLiveReport(run), 'utf8');
  await writeFile(rawPath, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
  return { reportPath, rawPath };
}
