import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { PROTOCOL_SCENARIOS } from './scenarios.js';
import { auditRules, formatAuditReport } from './ruleAuditor.js';
import { p95, runProtocolEvalSuite } from './runner.js';

/**
 * `npm run evals` — the scripted protocol suite's entry point (T15, PLAN §6).
 *
 * Runs all 30 scenarios against the StubGateway on embedded PGlite Postgres:
 * deterministic, no network, no credentials, CI-runnable, non-zero exit on any
 * scenario failure OR any rule-auditor violation. Contrast `npm run evals:live`
 * (T16), which is human-triggered and non-deterministic by nature.
 *
 *   npm run evals                                   # all 30 + the rule-auditor
 *   npm run evals -- --scenario happy-purchase-mcp  # a subset
 *   npm run evals -- --out evals                    # where the artifacts land
 *
 * Artifacts (git-ignored working output, not committed):
 *   <out>/protocol-report.json     — per-scenario results + the scoreboard numbers
 *   <out>/protocol-audit-log.jsonl — the whole batch's audit_events rows, one per
 *                                    line: the ONLY input `npm run audit:rules`
 *                                    (and the auditor here) reads.
 */

interface CliArgs {
  readonly scenarioIds: readonly string[];
  readonly outDir: string;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const scenarioIds: string[] = [];
  let outDir = 'evals';
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };
    if (arg === '--scenario') scenarioIds.push(next());
    else if (arg === '--out') outDir = next();
    else throw new Error(`unknown argument: ${arg}`);
  }
  return { scenarioIds, outDir };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const total = args.scenarioIds.length === 0 ? PROTOCOL_SCENARIOS.length : args.scenarioIds.length;
  console.log(`[protocol-evals] ${total} scenarios · stub gateway · embedded PGlite · zero network`);

  const run = await runProtocolEvalSuite({ scenarioIds: args.scenarioIds, log: console.log });

  const passed = run.results.filter((result) => result.passed).length;
  const failed = run.results.length - passed;
  const audit = auditRules(run.auditLog);
  const checkoutP95 = p95(run.checkoutLatenciesMs);

  const outDir = path.resolve(args.outDir);
  await mkdir(outDir, { recursive: true });
  const reportPath = path.join(outDir, 'protocol-report.json');
  const auditLogPath = path.join(outDir, 'protocol-audit-log.jsonl');
  await writeFile(
    auditLogPath,
    run.auditLog.map((record) => JSON.stringify(record)).join('\n') + '\n',
    'utf8',
  );
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        startedAt: run.startedAt,
        scoreboard: {
          scenarios: run.results.length,
          passed,
          failed,
          taskSuccessPercent: Math.round((passed / run.results.length) * 1000) / 10,
          auditedViolations: audit.violations.length,
          checkoutLatency: {
            p95Ms: checkoutP95 === null ? null : Math.round(checkoutP95 * 10) / 10,
            samples: run.checkoutLatenciesMs.length,
          },
        },
        ruleAuditor: audit,
        results: run.results,
      },
      null,
      2,
    ),
    'utf8',
  );

  console.log('');
  console.log(formatAuditReport(audit));
  console.log('');
  console.log('[protocol-evals] scoreboard');
  console.log(`  scenarios          ${passed}/${run.results.length} passed`);
  console.log(`  audited violations ${audit.violations.length}`);
  console.log(
    `  checkout latency   p95 ${checkoutP95 === null ? 'n/a' : `${checkoutP95.toFixed(1)}ms`} ` +
      `over ${run.checkoutLatenciesMs.length} successful submit_payment calls (stub gateway — protocol overhead only)`,
  );
  console.log(`  report             ${reportPath}`);
  console.log(`  audit log          ${auditLogPath}  (input to npm run audit:rules)`);

  if (failed > 0 || audit.violations.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error('[protocol-evals] failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
