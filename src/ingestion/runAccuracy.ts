import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  type DemoItemScore,
  fieldInstances,
  scoreDemoItem,
  summarizeDemo,
  thresholdSweep,
} from './accuracy.js';
import { DEMO_DATASET_DIR, loadDemoDataset, loadDemoImage } from './demoDataset.js';
import { createExtractionModel } from './extractionModel.js';
import { type AssembledProduct, AUTO_PUBLISH_THRESHOLD, assembleProduct } from './pipeline.js';

/**
 * The reportable per-field accuracy run (issue #13): the real extraction model
 * over all 28 demo-dataset items, scored against the hand labels, plus the
 * threshold sweep `AUTO_PUBLISH_THRESHOLD` is tuned on and a simulation of
 * what the lifecycle gate would publish versus hold.
 *
 *   npm run ingest:accuracy                                        # default model
 *   EXTRACTION_MODEL=gpt-5 npm run ingest:accuracy                 # the step-up, config only
 *   npm run ingest:accuracy -- --out=fixtures/demo-dataset/runs/x.json
 *
 * By default the record lands at `fixtures/demo-dataset/runs/<model>.json`
 * and is committed, like the spike's runs: every accuracy number the repo
 * claims is read off a committed record, raw model output included, not taken
 * on trust. `demoRun.test.ts` then pins the committed record in CI.
 *
 * A script, not a test — live billed calls, ~28 items of them (same argument
 * as the spike runner; the scoring itself is unit-tested in
 * `accuracy.test.ts`). Labels are loaded for scoring only and are never part
 * of the model input.
 */

const FLOOR = 0.7;

function parseOutPath(argv: readonly string[]): string | null {
  const flag = argv.find((arg) => arg.startsWith('--out='));
  return flag === undefined ? null : flag.slice('--out='.length);
}

const pct = (n: number): string => `${(n * 100).toFixed(0)}%`;
const mark = (ok: boolean): string => (ok ? 'PASS' : 'FAIL');

function reportItem(score: DemoItemScore, assembled: AssembledProduct): void {
  console.log(`\n${score.id}  →  ${assembled.status}`);
  console.log(`  name        ${mark(score.name.match)}  expected ${JSON.stringify(score.name.expected)}, got ${JSON.stringify(score.name.actual)} (conf ${score.name.confidence.toFixed(2)})`);
  console.log(`  price       ${mark(score.price.match)}  expected ${String(score.price.expected)}, got ${String(score.price.actual)} from ${JSON.stringify(score.priceText)} (conf ${score.price.confidence.toFixed(2)})`);
  console.log(`  stock       ${mark(score.stock.match)}  expected ${String(score.stock.expected)}, got ${String(score.stock.actual)}`);
  console.log(`  variants    ${mark(score.variantLabels.match)}  expected ${JSON.stringify(score.variantLabels.expected)}, got ${JSON.stringify(score.variantLabels.actual)}`);
  console.log(`  descr       ${mark(score.descriptionPresence.match)}  present: ${String(score.descriptionPresence.actual)}`);
  console.log(`  var. stock  ${mark(score.variantStock.match)}  expected ${JSON.stringify(score.variantStock.expected)}, got ${JSON.stringify(score.variantStock.actual)}`);
  for (const hold of assembled.record.holds) {
    console.log(`  hold: [${hold.field}] ${hold.reason}`);
  }
}

async function run(): Promise<void> {
  const dataset = await loadDemoDataset();
  const model = createExtractionModel();
  const out =
    parseOutPath(process.argv.slice(2)) ??
    resolve(DEMO_DATASET_DIR, 'runs', `${model.modelId}.json`);

  console.log('T12 — per-field extraction accuracy vs hand labels');
  console.log(`  model:     ${model.modelId}`);
  console.log(`  dataset:   ${String(dataset.items.length)} items, merchant "${dataset.merchant}"`);
  console.log(`  floor:     ${pct(FLOOR)} per reportable field`);
  console.log(`  threshold: ${AUTO_PUBLISH_THRESHOLD.toFixed(2)} (auto-publish)`);

  const startedAt = new Date();
  const scores: DemoItemScore[] = [];
  const assembledAll: AssembledProduct[] = [];
  const records: unknown[] = [];

  for (const item of dataset.items) {
    const result = await model.extract({
      caption: item.caption,
      image: await loadDemoImage(item.image),
    });
    const score = scoreDemoItem(item.id, item.label, result.extraction);
    const assembled = assembleProduct(
      { sourceId: item.id, caption: item.caption, imagePath: `fixtures/demo-dataset/${item.image}` },
      result.extraction,
      { modelId: result.modelId, extractedAt: startedAt },
    );
    scores.push(score);
    assembledAll.push(assembled);
    records.push({ id: item.id, servedByModelId: result.modelId, score, holds: assembled.record.holds, status: assembled.status, raw: result.rawResponse });
    reportItem(score, assembled);
  }

  const summary = summarizeDemo(scores);
  const instances = fieldInstances(scores);
  const sweep = thresholdSweep(instances);
  const wrongFields = instances.filter((i) => !i.correct);
  const elapsedSeconds = Math.round((Date.now() - startedAt.getTime()) / 1000);

  const published = assembledAll.filter((a) => a.status === 'published');
  const held = assembledAll.filter((a) => a.status === 'needs_confirmation');
  // The number that must be zero for the gate to be doing its job on this run:
  // published Products carrying any field the labels say is wrong.
  const wrongByItem = new Map<string, string[]>();
  for (const wrong of wrongFields) {
    wrongByItem.set(wrong.id, [...(wrongByItem.get(wrong.id) ?? []), wrong.field]);
  }
  const publishedWithWrongField = published
    .filter((a) => wrongByItem.has(a.sourceId))
    .map((a) => ({ id: a.sourceId, wrongFields: wrongByItem.get(a.sourceId) ?? [] }));

  console.log(`\n--- ${model.modelId} · ${String(elapsedSeconds)}s ---`);
  for (const field of summary.perField) {
    const floorMet = field.accuracy >= FLOOR;
    console.log(`  ${field.field.padEnd(20)} ${String(field.matches)}/${String(field.items)}  ${pct(field.accuracy).padStart(4)}  ${floorMet ? '' : '<-- BELOW FLOOR'}`);
  }
  console.log(`  ${'variantStock (info)'.padEnd(20)} ${String(summary.variantStock.matches)}/${String(summary.variantStock.items)}  ${pct(summary.variantStock.accuracy).padStart(4)}`);
  console.log(`\n  lifecycle at threshold ${AUTO_PUBLISH_THRESHOLD.toFixed(2)}: ${String(published.length)} published, ${String(held.length)} needs-confirmation`);
  console.log(`  published items carrying a wrong field: ${String(publishedWithWrongField.length)}${publishedWithWrongField.length > 0 ? '  <-- the gate failed on this run' : ''}`);
  console.log('\n  threshold sweep (wrong fields that would clear it / correct fields it lets through):');
  for (const point of sweep) {
    console.log(`    >= ${point.threshold.toFixed(2)}  wrong ${String(point.wrongAtOrAbove).padStart(2)}   correct ${String(point.correctAtOrAbove)}`);
  }

  const allFloorsMet = summary.perField.every((f) => f.accuracy >= FLOOR);
  console.log(allFloorsMet ? '\nFloor met on every reportable field.' : '\nFloor MISSED — see the fields marked above; report the number honestly, do not tune labels.');

  const record = {
    model: model.modelId,
    ranAt: startedAt.toISOString(),
    elapsedSeconds,
    accuracyFloor: FLOOR,
    allFloorsMet,
    autoPublishThreshold: AUTO_PUBLISH_THRESHOLD,
    dataset: { merchant: dataset.merchant, items: dataset.items.length },
    summary,
    lifecycle: {
      published: published.length,
      needsConfirmation: held.length,
      publishedIds: published.map((a) => a.sourceId),
      publishedWithWrongField,
    },
    wrongFields,
    sweep,
    records,
  };
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`Wrote ${out}`);
}

run().catch((error: unknown) => {
  console.error('[ingest:accuracy] failed', error);
  process.exit(1);
});
