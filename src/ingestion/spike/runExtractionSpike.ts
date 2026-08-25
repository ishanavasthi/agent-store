import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Paise, formatPaise } from '../../domain/money.js';
import { createExtractionModel } from '../extractionModel.js';
import type { ExtractionModel } from '../types.js';
import { type ItemScore, type SpikeLabel, parseSpikeLabel, scoreItem, summarize } from './scoring.js';

/**
 * Spike S3 (PLAN §7): run the extraction model over the hand-labeled fixture
 * dataset and report name+price exact-match.
 *
 *   npm run spike:extraction                                   # the default model
 *   EXTRACTION_MODEL=gpt-5 npm run spike:extraction            # the S3 step-up
 *   npm run spike:extraction -- --out=runs/gpt-5-mini.json     # keep the record
 *
 * Which model runs is configuration and nothing else (spec story 42): this
 * script has no model flag of its own, so a recorded run and a production
 * ingestion run pick their model through the same `EXTRACTION_MODEL`.
 *
 * The script compiles first and runs out of `dist` rather than running the
 * `.ts` directly under `--experimental-strip-types`: type stripping does not
 * rewrite a `./x.js` import specifier to `./x.ts`, so every `src` entrypoint
 * dies on its first relative import. See the engineering log.
 *
 * A script, not a test. It makes live billed calls and its result is a
 * measurement, not an assertion — putting it in `npm test` would make CI
 * non-deterministic, slow and chargeable, and would turn an OpenAI outage into
 * a red build (spec: the live suite is reported separately from the scripted
 * one). `vitest.config.ts` only collects files ending in `.test.ts`, so this
 * file is outside the suite by construction; the scoring is unit-tested next
 * door in `scoring.test.ts`, which is where the K2 metric gets pinned.
 */

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../fixtures/extraction-spike');

/** The floor from PLAN §7. Below it on gpt-5-mini → step up; below it on gpt-5 → K2. */
const ACCURACY_FLOOR = 0.7;

interface DatasetItem {
  readonly id: string;
  readonly image: string;
  readonly caption: string;
  readonly label: SpikeLabel;
}

interface Dataset {
  readonly merchant: string;
  readonly items: readonly DatasetItem[];
}

/**
 * `dataset.json` is untrusted input like any other file on disk — the labels
 * are hand-written, and `parseSpikeLabel` is where a mistyped price stops the
 * run instead of quietly scoring every model against a wrong answer.
 */
function parseDataset(raw: string): Dataset {
  const json = JSON.parse(raw) as {
    merchant: string;
    items: { id: string; image: string; caption: string; label: SpikeLabel }[];
  };
  return {
    merchant: json.merchant,
    items: json.items.map((item) => ({
      id: item.id,
      image: item.image,
      caption: item.caption,
      label: parseSpikeLabel(item.label),
    })),
  };
}

function parseOutPath(argv: readonly string[]): string | null {
  const flag = argv.find((arg) => arg.startsWith('--out='));
  return flag === undefined ? null : flag.slice('--out='.length);
}

async function loadImage(relativePath: string): Promise<{ mediaType: string; base64: string }> {
  const bytes = await readFile(resolve(FIXTURES, relativePath));
  return { mediaType: 'image/jpeg', base64: bytes.toString('base64') };
}

function describePrice(value: Paise | null): string {
  return value === null ? '—' : formatPaise(value);
}

function reportItem(score: ItemScore): void {
  const mark = (ok: boolean): string => (ok ? 'PASS' : 'FAIL');
  console.log(`\n${score.id}`);
  console.log(`  name   ${mark(score.name.match)}  expected ${JSON.stringify(score.name.expected)}`);
  console.log(`                  got      ${JSON.stringify(score.name.actual)} (conf ${score.nameConfidence.toFixed(2)})`);
  console.log(`  price  ${mark(score.price.match)}  expected ${describePrice(score.price.expected)}`);
  console.log(`                  got      ${describePrice(score.price.actual)} from ${JSON.stringify(score.priceText)} (conf ${score.priceConfidence.toFixed(2)})`);
  console.log(`  stock  ${mark(score.stock.match)}  expected ${String(score.stock.expected)}  got ${String(score.stock.actual)}`);
  console.log(`  sizes  ${mark(score.variantLabels.match)}  expected ${JSON.stringify(score.variantLabels.expected)}  got ${JSON.stringify(score.variantLabels.actual)}`);
}

async function run(): Promise<void> {
  const out = parseOutPath(process.argv.slice(2));
  const dataset = parseDataset(await readFile(resolve(FIXTURES, 'dataset.json'), 'utf8'));
  const model: ExtractionModel = createExtractionModel();

  console.log(`Spike S3 — extraction quality floor`);
  console.log(`  model:   ${model.modelId}`);
  console.log(`  dataset: ${String(dataset.items.length)} items, merchant "${dataset.merchant}"`);
  console.log(`  metric:  name + price exact-match vs hand labels (floor ${String(ACCURACY_FLOOR * 100)}%)`);

  const startedAt = new Date();
  // Sequential rather than concurrent: five items take under a minute either
  // way, and a serial run keeps the per-item output readable and rate limits
  // out of the picture.
  const scores: ItemScore[] = [];
  const records: unknown[] = [];

  for (const item of dataset.items) {
    const result = await model.extract({
      caption: item.caption,
      image: await loadImage(item.image),
    });
    const score = scoreItem(item.id, item.label, result.extraction);
    scores.push(score);
    records.push({ id: item.id, servedByModelId: result.modelId, score, raw: result.rawResponse });
    reportItem(score);
  }

  const summary = summarize(scores);
  const elapsedSeconds = Math.round((Date.now() - startedAt.getTime()) / 1000);
  const percent = (n: number): string => `${(n * 100).toFixed(0)}%`;

  console.log(`\n--- ${model.modelId} · ${String(elapsedSeconds)}s ---`);
  console.log(`  name+price exact-match : ${String(summary.nameAndPriceMatches)}/${String(summary.items)}  ${percent(summary.nameAndPriceAccuracy)}   <-- the S3 gate`);
  console.log(`  name only              : ${String(summary.nameMatches)}/${String(summary.items)}`);
  console.log(`  price only             : ${String(summary.priceMatches)}/${String(summary.items)}`);
  console.log(`  stock (incl. null)     : ${String(summary.stockMatches)}/${String(summary.items)}`);
  console.log(`  variant labels         : ${String(summary.variantMatches)}/${String(summary.items)}`);

  const passed = summary.nameAndPriceAccuracy >= ACCURACY_FLOOR;
  console.log(
    passed
      ? `\nFloor met. No step-up needed at ${model.modelId}.`
      : `\nFloor MISSED at ${model.modelId}. Re-run with EXTRACTION_MODEL=gpt-5; if that also misses, K2 fires (PLAN §9).`,
  );

  if (out !== null) {
    // Everything PLAN §7 is allowed to claim about this run, so the prose can be
    // checked against the record rather than believed.
    const record = {
      model: model.modelId,
      ranAt: startedAt.toISOString(),
      elapsedSeconds,
      accuracyFloor: ACCURACY_FLOOR,
      floorMet: passed,
      dataset: { merchant: dataset.merchant, items: dataset.items.length },
      summary,
      records,
    };
    await writeFile(resolve(out), `${JSON.stringify(record, null, 2)}\n`);
    console.log(`Wrote ${out}`);
  }
}

run().catch((error: unknown) => {
  console.error('[spike] failed', error);
  process.exit(1);
});
