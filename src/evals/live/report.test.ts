import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { renderLiveReport, writeLiveReport } from './report.js';
import type { LiveSuiteRun } from './types.js';

const run: LiveSuiteRun = {
  target: 'https://merchant.example',
  startedAt: '2026-08-26T10:00:00.000Z',
  dryRun: true,
  results: [
    {
      task: {
        id: 'black-tee-under-1500',
        instruction: 'Buy a black tee under ₹1,500',
        capPaise: 500_000,
        expectation: 'paid',
      },
      decision: {
        action: 'buy',
        want: 'a black tee',
        budgetPaise: 150_000,
        items: [{ variantId: 'var_x', quantity: 1 }],
        reasoning: 'best match',
      },
      outcome: {
        kind: 'dry_run_stopped',
        orderId: 'ord_1',
        paymentLinkUrl: 'https://rzp.io/x',
        auditUrl: 'https://merchant.example/audit/ord_1',
      },
      transcript: ['claude: looking at the catalog'],
      startedAt: '2026-08-26T10:00:01.000Z',
      durationMs: 4200,
      costUsd: 0.0123,
    },
  ],
};

describe('the live report', () => {
  let dir: string | null = null;

  afterEach(async () => {
    if (dir !== null) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  it('is loud about non-determinism and its separation from the scoreboard', () => {
    const report = renderLiveReport(run);
    expect(report).toContain('Non-deterministic by nature');
    expect(report).toContain('never be read as a benchmark');
    expect(report).toContain('separate from the scripted suite');
    expect(report).toContain('DRY RUN — no payment page was ever driven');
    expect(report).toContain('₹5000.00'); // the cap, in rupees
    expect(report).toContain('$0.0123');
    expect(report).toContain('claude: looking at the catalog');
  });

  it('writes the stable report file plus timestamped raw evidence', async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'live-report-'));
    const written = await writeLiveReport(dir, run);

    expect(written.reportPath).toBe(path.join(dir, 'live-report.md'));
    expect(written.rawPath).toBe(
      path.join(dir, 'live-runs', '2026-08-26T10-00-00Z-dry-run.json'),
    );
    expect(await readFile(written.reportPath, 'utf8')).toContain('# Live eval report');
    const raw = JSON.parse(await readFile(written.rawPath, 'utf8')) as LiveSuiteRun;
    expect(raw).toEqual(run);
  });
});
