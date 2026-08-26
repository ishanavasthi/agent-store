import { performance } from 'node:perf_hooks';
import { PROTOCOL_SCENARIOS, type Scenario } from './scenarios.js';
import { createScenarioWorld } from './world.js';
import {
  ScenarioFailure,
  type AuditLogRecord,
  type ProtocolSuiteRun,
  type ScenarioResult,
} from './types.js';

/**
 * The scenario runner (T15, PLAN §6). Scenarios run sequentially, each in a
 * fresh world — its own embedded Postgres, its own StubGateway, its own
 * ephemeral HTTP server — so no scenario can lean on another's state and the
 * whole batch is order-independent and deterministic. After each scenario the
 * world's entire audit log is exported (tagged with the scenario id, for
 * provenance only) into the batch log the rule-auditor consumes.
 *
 * The `oversell-refund-cross-face` scenario's world starts with the seeded
 * shelf too — the scenario itself drains the tee to one unit, because "the
 * merchant had stock and it ran out" is part of that story.
 */

export interface RunnerOptions {
  /** Subset by scenario id; empty/omitted runs all. */
  readonly scenarioIds?: readonly string[];
  readonly log?: (line: string) => void;
}

export function scenarioById(id: string): Scenario {
  const scenario = PROTOCOL_SCENARIOS.find((candidate) => candidate.id === id);
  if (scenario === undefined) {
    throw new Error(
      `unknown scenario '${id}' — known: ${PROTOCOL_SCENARIOS.map((s) => s.id).join(', ')}`,
    );
  }
  return scenario;
}

export async function runProtocolEvalSuite(
  options: RunnerOptions = {},
): Promise<ProtocolSuiteRun> {
  const log = options.log ?? (() => undefined);
  const scenarios =
    options.scenarioIds === undefined || options.scenarioIds.length === 0
      ? PROTOCOL_SCENARIOS
      : options.scenarioIds.map(scenarioById);

  const startedAt = new Date().toISOString();
  const results: ScenarioResult[] = [];
  const auditLog: AuditLogRecord[] = [];
  const checkoutLatenciesMs: number[] = [];

  for (const scenario of scenarios) {
    const world = await createScenarioWorld();
    const scenarioStart = performance.now();
    let passed = true;
    let reason: string | null = null;
    try {
      await scenario.run(world);
    } catch (error) {
      passed = false;
      reason =
        error instanceof ScenarioFailure
          ? error.message
          : `unexpected error: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      const durationMs = performance.now() - scenarioStart;
      // The audit log is exported even for a failed scenario: what the world
      // wrote is evidence either way, and the auditor judges all of it.
      try {
        auditLog.push(...(await world.exportAuditLog(scenario.id)));
      } catch (error) {
        passed = false;
        reason ??= `audit log export failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      checkoutLatenciesMs.push(...world.checkoutLatenciesMs);
      await world.close();
      results.push({
        id: scenario.id,
        name: scenario.name,
        face: scenario.face,
        category: scenario.category,
        expected: scenario.expected,
        passed,
        reason,
        durationMs,
      });
      log(
        `${passed ? '  ✓' : '  ✗'} [${scenario.face.padEnd(4)}] ${scenario.id}` +
          (reason === null ? '' : ` — ${reason}`),
      );
    }
  }

  return { startedAt, results, checkoutLatenciesMs, auditLog };
}

/** p95 over the recorded checkout latencies (nearest-rank), null when none. */
export function p95(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(0.95 * sorted.length);
  return sorted[Math.min(rank, sorted.length) - 1]!;
}
