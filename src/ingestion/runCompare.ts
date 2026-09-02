import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DEMO_DATASET_DIR } from './demoDataset.js';
import { type RunRecord, compareRow, formatCompareTable } from './runRecord.js';

/**
 * One table over every committed accuracy record (plan §5, S2.3):
 *
 *   npm run ingest:compare
 *
 * Choosing the demo model is a measurement, and this is where the
 * measurements are read side by side. The ordering rule is the ticket's, not
 * this script's: `publishedWithWrongField` must be zero first — a model that
 * auto-publishes a field the hand labels call wrong is disqualified however
 * good its accuracy looks — then per-field accuracy, then latency. So the
 * `wrongPublished` column sorts to the front and rows that fail it are called
 * out under the table rather than silently ranked.
 *
 * Reads only committed JSON; makes no network calls and costs nothing.
 */

async function run(): Promise<void> {
  const runsDir = resolve(DEMO_DATASET_DIR, 'runs');
  const files = (await readdir(runsDir)).filter((name) => name.endsWith('.json')).sort();
  if (files.length === 0) {
    console.log(`No run records in ${runsDir}. Run \`npm run ingest:accuracy\` first.`);
    return;
  }

  const rows = [];
  for (const file of files) {
    const record = JSON.parse(await readFile(resolve(runsDir, file), 'utf8')) as RunRecord;
    rows.push(compareRow(record));
  }

  console.log(`Committed accuracy runs (${String(rows.length)}), ${runsDir}\n`);
  console.log(formatCompareTable(rows));

  const disqualified = rows.filter((row) => row.publishedWithWrongField > 0);
  console.log(
    disqualified.length === 0
      ? '\nEvery run auto-published zero wrong fields. Rank on per-field accuracy, then latency.'
      : `\nDisqualified (auto-published a wrong field): ${disqualified
          .map((row) => `${row.model} (${row.outputMode})`)
          .join(', ')}`,
  );
}

run().catch((error: unknown) => {
  console.error('[ingest:compare] failed', error);
  process.exit(1);
});
