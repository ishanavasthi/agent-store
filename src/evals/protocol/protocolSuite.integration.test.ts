import { describe, expect, it } from 'vitest';
import { PROTOCOL_SCENARIOS } from './scenarios.js';
import { auditRules } from './ruleAuditor.js';
import { p95, runProtocolEvalSuite } from './runner.js';

/**
 * T15's acceptance proof (issue #16), as vitest coverage of the runner itself:
 * the full 30-scenario suite runs green with the rule-auditor reporting zero
 * violations from the batch's audit log alone — and the auditor demonstrably
 * CATCHES a violation planted in a REAL exported log (its credibility test:
 * the synthetic-log cases live in ruleAuditor.test.ts; here the tampered rows
 * are the exact shape the suite exports).
 */

describe('the protocol eval suite', () => {
  it(
    'runs all 30 scenarios green and the rule-auditor reports zero violations',
    { timeout: 300_000 },
    async () => {
      const run = await runProtocolEvalSuite();

      expect(run.results).toHaveLength(30);
      expect(PROTOCOL_SCENARIOS).toHaveLength(30);
      const failures = run.results
        .filter((result) => !result.passed)
        .map((result) => `${result.id}: ${result.reason ?? ''}`);
      expect(failures).toEqual([]);

      // Both faces really were exercised.
      expect(run.results.some((result) => result.face === 'mcp')).toBe(true);
      expect(run.results.some((result) => result.face === 'rest')).toBe(true);
      expect(run.results.some((result) => result.face === 'both')).toBe(true);

      // The auditor judges the whole batch from the exported log alone.
      const report = auditRules(run.auditLog);
      expect(report.violations).toEqual([]);
      expect(report.chargesAudited).toBeGreaterThan(0);
      expect(report.refusalsAudited).toBeGreaterThan(0);

      // The scoreboard's latency figure has real samples behind it.
      expect(run.checkoutLatenciesMs.length).toBeGreaterThan(0);
      expect(p95(run.checkoutLatenciesMs)).toBeGreaterThan(0);
    },
  );

  it(
    'the auditor catches violations planted in a real exported log',
    { timeout: 120_000 },
    async () => {
      // One real purchase, exported exactly as `npm run evals` exports it.
      const run = await runProtocolEvalSuite({ scenarioIds: ['happy-purchase-mcp'] });
      expect(run.results[0]?.passed).toBe(true);
      expect(auditRules(run.auditLog).violations).toEqual([]);

      // Tamper 1: shrink the registered Cap below the charge that followed.
      const cappedLog = run.auditLog.map((event) =>
        event.type === 'agent.registered'
          ? { ...event, payload: { ...event.payload, capPaise: 1 } }
          : event,
      );
      expect(auditRules(cappedLog).violations.map((v) => v.code)).toContain('CHARGE_ABOVE_CAP');

      // Tamper 2: erase the trust gate's event — the charge loses its chain.
      const gatelessLog = run.auditLog.filter((event) => event.type !== 'payment.verified');
      expect(auditRules(gatelessLog).violations.map((v) => v.code)).toContain(
        'CHARGE_WITHOUT_VERIFIED_CHAIN',
      );
    },
  );
});
