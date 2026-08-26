import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { merchants, products, variants } from '../db/schema.js';
import { listPublishedVariants } from '../domain/catalog.js';
import { paise } from '../domain/money.js';
import { createTestDatabase, type TestDatabaseHandle } from '../testSupport/pgliteDatabase.js';
import { type IngestItem, ingestItems, productIdForSource } from './ingest.js';
import type { ExtractionInput, ExtractionModel, ExtractionResult, ProductExtraction } from './types.js';

/**
 * Ingestion against a real (embedded) Postgres with a canned extractor behind
 * the `ExtractionModel` seam — the deterministic, no-network half of issue
 * #13's test split. What is on trial here is the wiring the pure pipeline
 * tests cannot see: rows, the jsonb record, the published/held boundary as
 * the catalog reads it, and skip-on-re-ingest.
 */

const MERCHANT_ID = 'mrc_test_merchant';

function confident(overrides: Partial<ProductExtraction> = {}): ProductExtraction {
  return {
    name: { value: 'RAAT Oversized Tee', confidence: 0.97 },
    description: { value: 'Jet black oversized tee.', confidence: 0.95 },
    price: { value: paise(119900), confidence: 0.97 },
    priceText: { value: '₹1,199/-', confidence: 0.97 },
    stock: { value: 18, confidence: 0.95 },
    variantLabels: { value: [], confidence: 0.95 },
    variantStock: { value: {}, confidence: 0.95 },
    ...overrides,
  };
}

/** The canned extractor: fixed extractions per caption, zero network. */
function cannedModel(byCaption: Record<string, ProductExtraction>): ExtractionModel {
  return {
    modelId: 'canned-extractor',
    extract: (input: ExtractionInput): Promise<ExtractionResult> => {
      const extraction = byCaption[input.caption];
      if (extraction === undefined) throw new Error(`No canned extraction for: ${input.caption}`);
      return Promise.resolve({ extraction, modelId: 'canned-extractor-2026-08-26', rawResponse: '{}' });
    },
  };
}

function item(sourceId: string, caption: string): IngestItem {
  return { sourceId, caption, imagePath: `fixtures/demo-dataset/images/${sourceId}.jpg`, image: null };
}

describe('ingestItems', () => {
  let handle: TestDatabaseHandle;

  beforeEach(async () => {
    handle = await createTestDatabase();
    await handle.db.insert(merchants).values({ id: MERCHANT_ID, name: 'Kalaakar Streetwear' });
  });

  afterEach(async () => {
    await handle.close();
  });

  it('writes a published Product with full rows and a held one invisible to the catalog', async () => {
    const model = cannedModel({
      'publishable caption': confident(),
      'held caption': confident({ stock: { value: null, confidence: 0 } }),
    });

    const results = await ingestItems(handle.db, MERCHANT_ID, model, [
      item('01-publishable', 'publishable caption'),
      item('02-held', 'held caption'),
    ]);

    expect(results.map((r) => ({ status: r.status, created: r.created }))).toEqual([
      { status: 'published', created: true },
      { status: 'needs_confirmation', created: true },
    ]);

    // Only the published Product's Variant is buyable; the held one is
    // invisible in whole (CONTEXT.md → Published), not shown field-by-field.
    const buyable = await listPublishedVariants(handle.db, MERCHANT_ID);
    expect(buyable).toHaveLength(1);
    expect(buyable[0]).toMatchObject({
      productId: productIdForSource('01-publishable'),
      productTitle: 'RAAT Oversized Tee',
      label: null,
      stock: 18,
    });
    expect(buyable[0]?.price.amountPaise).toBe(119900);

    // The held Product's Variant row is honest: stock null, never defaulted.
    const heldRows = await handle.db
      .select()
      .from(variants)
      .where(eq(variants.productId, productIdForSource('02-held')));
    expect(heldRows).toHaveLength(1);
    expect(heldRows[0]?.stock).toBeNull();
    expect(heldRows[0]?.pricePaise).toBe(119900);
  });

  it('persists the per-field extraction record for the confirmation screen', async () => {
    const model = cannedModel({ 'held caption': confident({ stock: { value: null, confidence: 0 } }) });
    await ingestItems(handle.db, MERCHANT_ID, model, [item('02-held', 'held caption')]);

    const [row] = await handle.db
      .select()
      .from(products)
      .where(eq(products.id, productIdForSource('02-held')));

    expect(row?.status).toBe('needs_confirmation');
    expect(row?.extraction?.modelId).toBe('canned-extractor-2026-08-26');
    expect(row?.extraction?.caption).toBe('held caption');
    expect(row?.extraction?.fields.name).toEqual({
      value: 'RAAT Oversized Tee',
      confidence: 0.97,
      belowThreshold: false,
    });
    expect(row?.extraction?.holds).toEqual([
      { field: 'stock', reason: 'the caption never states a stock count' },
    ]);
  });

  it('creates one row per stated variant, price defaulted across all of them', async () => {
    const model = cannedModel({
      'variants caption': confident({
        stock: { value: null, confidence: 0 },
        variantLabels: { value: ['S', 'M', 'L'], confidence: 0.95 },
        variantStock: { value: { S: 4, M: 7, L: 2 }, confidence: 0.95 },
      }),
    });
    const [result] = await ingestItems(handle.db, MERCHANT_ID, model, [
      item('23-machli', 'variants caption'),
    ]);
    expect(result?.status).toBe('published');

    const rows = await handle.db
      .select()
      .from(variants)
      .where(eq(variants.productId, productIdForSource('23-machli')));
    expect(
      rows.map((r) => ({ label: r.label, stock: r.stock, pricePaise: r.pricePaise, isDefault: r.isDefault })),
    ).toEqual(
      expect.arrayContaining([
        { label: 'S', stock: 4, pricePaise: 119900, isDefault: false },
        { label: 'M', stock: 7, pricePaise: 119900, isDefault: false },
        { label: 'L', stock: 2, pricePaise: 119900, isDefault: false },
      ]),
    );
  });

  it('re-ingesting skips existing Products instead of clobbering them', async () => {
    const model = cannedModel({ 'publishable caption': confident() });
    const first = await ingestItems(handle.db, MERCHANT_ID, model, [
      item('01-publishable', 'publishable caption'),
    ]);
    expect(first[0]?.created).toBe(true);

    // The merchant corrects the title between runs (T13's job)…
    await handle.db
      .update(products)
      .set({ title: 'RAAT Oversized Tee — corrected' })
      .where(eq(products.id, productIdForSource('01-publishable')));

    // …and a re-run must not undo that.
    const second = await ingestItems(handle.db, MERCHANT_ID, model, [
      item('01-publishable', 'publishable caption'),
    ]);
    expect(second[0]?.created).toBe(false);

    const [row] = await handle.db
      .select()
      .from(products)
      .where(eq(products.id, productIdForSource('01-publishable')));
    expect(row?.title).toBe('RAAT Oversized Tee — corrected');

    const rows = await handle.db
      .select()
      .from(variants)
      .where(eq(variants.productId, productIdForSource('01-publishable')));
    expect(rows).toHaveLength(1);
  });
});
