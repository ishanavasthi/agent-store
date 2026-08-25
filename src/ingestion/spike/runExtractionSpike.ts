import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatPaise, paise } from '../../domain/money.js';
import { EXTRACTION_MODEL, createExtractionModel } from '../extractionModel.js';
import type { ExtractionModel, ProductExtraction } from '../types.js';
import { type ItemScore, type SpikeLabel, scoreItem, summarize } from './scoring.js';

/**
 * Spike S3 (PLAN §7): run the extraction model over the hand-labeled fixture
 * dataset and report name+price exact-match.
 *
 *   npm run spike:extraction                     # the configured default model
 *   npm run spike:extraction -- --model=gpt-5    # the K2 step-up run
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
  readonly tests: string;
}

interface Dataset {
  readonly merchant: string;
  readonly items: readonly DatasetItem[];
}

function parseArgs(argv: readonly string[]): { model: string; out: string | null } {
  let model = EXTRACTION_MODEL;
  let out: string | null = null;
  for (const arg of argv) {
    if (arg.startsWith('--model=')) model = arg.slice('--model='.length);
    else if (arg.startsWith('--out=')) out = arg.slice('--out='.length);
  }
  return { model, out };
}

async function loadImage(relativePath: string): Promise<{ mediaType: string; base64: string }> {
  const bytes = await readFile(resolve(FIXTURES, relativePath));
  return { mediaType: 'image/jpeg', base64: bytes.toString('base64') };
}

function describePrice(value: number | null): string {
  return value === null ? '—' : formatPaise(paise(value));
}

function reportItem(item: DatasetItem, score: ItemScore, extraction: ProductExtraction): void {
  const mark = (ok: boolean): string => (ok ? 'PASS' : 'FAIL');
  console.log(`\n${item.id}`);
  console.log(`  name   ${mark(score.name.match)}  expected ${JSON.stringify(score.name.expected)}`);
  console.log(`                  got      ${JSON.stringify(score.name.actual)} (conf ${score.nameConfidence.toFixed(2)})`);
  console.log(`  price  ${mark(score.price.match)}  expected ${describePrice(score.price.expected)}`);
  console.log(`                  got      ${describePrice(score.price.actual)} from ${JSON.stringify(extraction.priceText.value)} (conf ${score.priceConfidence.toFixed(2)})`);
  console.log(`  stock  ${mark(score.stock.match)}  expected ${String(score.stock.expected)}  got ${String(score.stock.actual)}`);
  console.log(`  sizes  ${mark(score.variantLabels.match)}  expected ${JSON.stringify(score.variantLabels.expected)}  got ${JSON.stringify(score.variantLabels.actual)}`);
}

async function run(): Promise<void> {
  const { model: modelName, out } = parseArgs(process.argv.slice(2));
  const dataset = JSON.parse(await readFile(resolve(FIXTURES, 'dataset.json'), 'utf8')) as Dataset;
  const model: ExtractionModel = createExtractionModel(modelName);

  console.log(`Spike S3 — extraction quality floor`);
  console.log(`  model:   ${model.name}`);
  console.log(`  dataset: ${String(dataset.items.length)} items, merchant "${dataset.merchant}"`);
  console.log(`  metric:  name + price exact-match vs hand labels (floor ${String(ACCURACY_FLOOR * 100)}%)`);

  const started = Date.now();
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
    records.push({ id: item.id, modelId: result.modelId, score, raw: result.rawResponse });
    reportItem(item, score, result.extraction);
  }

  const summary = summarize(scores);
  const percent = (n: number): string => `${(n * 100).toFixed(0)}%`;

  console.log(`\n--- ${model.name} · ${String(Math.round((Date.now() - started) / 1000))}s ---`);
  console.log(`  name+price exact-match : ${String(summary.nameAndPriceMatches)}/${String(summary.items)}  ${percent(summary.nameAndPriceAccuracy)}   <-- the S3 gate`);
  console.log(`  name only              : ${String(summary.nameMatches)}/${String(summary.items)}`);
  console.log(`  price only             : ${String(summary.priceMatches)}/${String(summary.items)}`);
  console.log(`  stock (incl. null)     : ${String(summary.stockMatches)}/${String(summary.items)}`);
  console.log(`  variant labels         : ${String(summary.variantMatches)}/${String(summary.items)}`);

  const passed = summary.nameAndPriceAccuracy >= ACCURACY_FLOOR;
  console.log(
    passed
      ? `\nFloor met. No step-up needed at ${model.name}.`
      : `\nFloor MISSED at ${model.name}. Re-run with --model=gpt-5; if that also misses, K2 fires (PLAN §9).`,
  );

  if (out !== null) {
    await writeFile(out, `${JSON.stringify({ model: model.name, summary, records }, null, 2)}\n`);
    console.log(`Wrote ${out}`);
  }
}

run().catch((error: unknown) => {
  console.error('[spike] failed', error);
  process.exit(1);
});
