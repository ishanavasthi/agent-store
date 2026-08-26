import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { auditRules, formatAuditReport, type AuditableEvent } from './ruleAuditor.js';

/**
 * `npm run audit:rules` — the rule-auditor as its own command (T15, PLAN §6):
 * a SEPARATE script whose only input is the audit log. It knows nothing about
 * scenarios, expected outcomes, or app state; it reads the exported
 * `audit_events` rows and recomputes the guarantees from the logged payloads
 * alone (see src/evals/protocol/ruleAuditor.ts for the four asserts).
 *
 *   npm run evals                                    # produces the log, audits it inline
 *   npm run audit:rules                              # re-audit the last batch's log
 *   npm run audit:rules -- --log path/to/rows.jsonl  # audit any exported log
 *
 * The JSONL is a straight export of `audit_events` (seq, type, orderId,
 * merchantId, payload — one JSON object per line). The eval batch runs on an
 * in-memory Postgres, so the export IS that database's audit_events table; an
 * export of a deployed database's rows in the same shape audits identically.
 */

interface CliArgs {
  readonly logPath: string;
}

function parseArgs(argv: readonly string[]): CliArgs {
  let logPath = path.join('evals', 'protocol-audit-log.jsonl');
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--log') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error('--log needs a value');
      logPath = value;
      i += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { logPath: path.resolve(logPath) };
}

function parseRecord(line: string, lineNumber: number): AuditableEvent {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new Error(`line ${lineNumber} is not JSON`);
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new Error(`line ${lineNumber} is not an audit event object`);
  }
  const record = raw as Record<string, unknown>;
  const seq = record['seq'];
  const type = record['type'];
  const orderId = record['orderId'];
  const payload = record['payload'];
  if (typeof seq !== 'number' || typeof type !== 'string') {
    throw new Error(`line ${lineNumber} lacks numeric seq / string type`);
  }
  return {
    seq,
    type,
    orderId: typeof orderId === 'string' ? orderId : null,
    payload:
      typeof payload === 'object' && payload !== null && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : {},
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  let content: string;
  try {
    content = await readFile(args.logPath, 'utf8');
  } catch {
    throw new Error(
      `no audit log at ${args.logPath} — run \`npm run evals\` first (it exports the batch's ` +
        'audit_events rows there), or pass --log <path> to an exported log',
    );
  }
  const events = content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line, index) => parseRecord(line, index + 1));

  console.log(`[audit:rules] ${args.logPath}`);
  const report = auditRules(events);
  console.log(formatAuditReport(report));
  if (report.violations.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error('[audit:rules] failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
