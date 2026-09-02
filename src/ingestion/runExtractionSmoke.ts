import { loadDemoDataset, loadDemoImage } from './demoDataset.js';
import { readExtractionProviderConfig } from './extraction/config.js';
import { createExtractionModelFromConfig } from './extractionModel.js';
import { assembleProduct } from './pipeline.js';

/**
 * The cheap "is this adapter alive" check (plan §5, S2.3): a handful of demo
 * captions through whatever `EXTRACTION_*` currently names, printing the
 * fields, the holds and the raw payload. No database, no scoring, no record.
 *
 *   npm run ingest:smoke                      # 3 items
 *   npm run ingest:smoke -- --items=1
 *   EXTRACTION_PROVIDER=openrouter EXTRACTION_MODEL=z-ai/glm-5.3-flash \
 *     EXTRACTION_OUTPUT_MODE=tool_call npm run ingest:smoke -- --items=3
 *
 * It exists because `ingest:accuracy` is 28 live billed calls and a broken
 * adapter — a wrong model id, a provider that ignores the schema, a dead key
 * — fails on the first one just as informatively as on the twenty-eighth.
 * Run this first, every time, against a provider you have not run before.
 *
 * The raw payload is printed in full on purpose: the failure this catches is
 * usually *drift* (a map-shaped `variantStock`, a stringified count) that zod
 * turns into an `ExtractionError`, and the payload is the evidence for the
 * engineering log.
 */

const DEFAULT_ITEMS = 3;

function parseItemCount(argv: readonly string[]): number {
  const flag = argv.find((arg) => arg.startsWith('--items='));
  if (flag === undefined) return DEFAULT_ITEMS;
  const parsed = Number(flag.slice('--items='.length));
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`--items must be a positive integer, not \`${flag.slice('--items='.length)}\``);
  }
  return parsed;
}

async function run(): Promise<void> {
  const dataset = await loadDemoDataset();
  const config = readExtractionProviderConfig();
  const model = createExtractionModelFromConfig(config);
  const items = dataset.items.slice(0, parseItemCount(process.argv.slice(2)));

  console.log('S2.3 — extraction smoke (no database, no scoring)');
  console.log(`  provider:  ${config.provider}`);
  console.log(`  model:     ${config.model}`);
  console.log(`  mode:      ${config.outputMode}`);
  console.log(`  items:     ${String(items.length)} of ${String(dataset.items.length)}`);

  const startedAt = new Date();
  for (const item of items) {
    console.log(`\n=== ${item.id} ===`);
    const result = await model.extract({
      caption: item.caption,
      image: await loadDemoImage(item.image),
    });
    const extraction = result.extraction;
    const assembled = assembleProduct(
      { sourceId: item.id, caption: item.caption, imagePath: `fixtures/demo-dataset/${item.image}` },
      extraction,
      { modelId: result.modelId, extractedAt: startedAt },
    );

    console.log(`  served by   ${result.modelId}`);
    console.log(`  status      ${assembled.status}`);
    console.log(`  name        ${JSON.stringify(extraction.name.value)} (conf ${extraction.name.confidence.toFixed(2)})`);
    console.log(`  price       ${String(extraction.price.value)} from ${JSON.stringify(extraction.priceText.value)} (conf ${extraction.price.confidence.toFixed(2)})`);
    console.log(`  stock       ${String(extraction.stock.value)} (conf ${extraction.stock.confidence.toFixed(2)})`);
    console.log(`  variants    ${JSON.stringify(extraction.variantLabels.value)} (conf ${extraction.variantLabels.confidence.toFixed(2)})`);
    console.log(`  var. stock  ${JSON.stringify(extraction.variantStock.value)}`);
    console.log(`  descr       ${JSON.stringify(extraction.description.value)}`);
    for (const hold of assembled.record.holds) {
      console.log(`  hold: [${hold.field}] ${hold.reason}`);
    }
    console.log(`  raw: ${result.rawResponse}`);
  }

  const elapsedSeconds = Math.round((Date.now() - startedAt.getTime()) / 1000);
  console.log(`\n${String(items.length)} item(s) extracted in ${String(elapsedSeconds)}s. The adapter is alive.`);
}

run().catch((error: unknown) => {
  console.error('[ingest:smoke] failed', error);
  process.exit(1);
});
