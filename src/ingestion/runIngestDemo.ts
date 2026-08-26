import { MERCHANT_ID } from '../config.js';
import { createDatabase } from '../db/client.js';
import { loadDemoDataset, loadDemoImage } from './demoDataset.js';
import { createExtractionModel } from './extractionModel.js';
import { type IngestItem, ingestItems } from './ingest.js';
import { AUTO_PUBLISH_THRESHOLD } from './pipeline.js';

/**
 * Ingest the demo dataset into the catalog: 28 captions+photos → Product and
 * Variant rows with per-field confidence records, lifecycle-gated at
 * `AUTO_PUBLISH_THRESHOLD`. What T13's merchant confirmation screen reads.
 *
 *   npm run ingest:demo
 *
 * Live billed extraction calls (one per item) against `EXTRACTION_MODEL`, and
 * real writes against `DATABASE_URL`. Hand labels are never read here — the
 * pipeline sees exactly what a real merchant upload would contain.
 *
 * Idempotent by skipping: a Product that already exists is left untouched
 * (see `ingest.ts` — re-running must never clobber merchant corrections), so
 * a partial run can simply be re-run.
 *
 * Reads `DATABASE_URL` directly rather than `loadConfig()`: ingestion has no
 * business demanding Razorpay credentials (same argument as
 * `extractionModel.ts` for the model knobs).
 */

async function run(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL']?.trim() ?? '';
  if (databaseUrl === '') {
    throw new Error('Missing DATABASE_URL. See .env.example.');
  }

  const dataset = await loadDemoDataset();
  const model = createExtractionModel();
  const { db, close } = createDatabase(databaseUrl);

  console.log('T12 — ingest the demo dataset');
  console.log(`  model:     ${model.modelId}`);
  console.log(`  merchant:  ${MERCHANT_ID} ("${dataset.merchant}")`);
  console.log(`  items:     ${String(dataset.items.length)}`);
  console.log(`  threshold: ${AUTO_PUBLISH_THRESHOLD.toFixed(2)} (auto-publish)`);

  try {
    const items: IngestItem[] = [];
    for (const item of dataset.items) {
      items.push({
        sourceId: item.id,
        caption: item.caption,
        imagePath: `fixtures/demo-dataset/${item.image}`,
        image: await loadDemoImage(item.image),
      });
    }

    const results = await ingestItems(db, MERCHANT_ID, model, items, {}, (product) => {
      const verdict = product.status === 'published' ? 'published          ' : 'needs-confirmation ';
      const note = product.created
        ? product.holds.map((h) => h.field).join(', ')
        : 'already exists — skipped';
      console.log(`  ${verdict} ${product.productId}  ${note === '' ? '' : `(${note})`}`);
    });

    const created = results.filter((r) => r.created);
    const published = created.filter((r) => r.status === 'published');
    const held = created.filter((r) => r.status === 'needs_confirmation');
    const skipped = results.length - created.length;
    console.log(
      `\n  ${String(created.length)} ingested: ${String(published.length)} published, ` +
        `${String(held.length)} needs-confirmation` +
        (skipped > 0 ? ` (${String(skipped)} already existed, skipped)` : ''),
    );
    if (held.length > 0) {
      console.log('  held Products await the merchant on the T13 confirmation screen.');
    }
  } finally {
    await close();
  }
}

run().catch((error: unknown) => {
  console.error('[ingest:demo] failed', error);
  process.exit(1);
});
