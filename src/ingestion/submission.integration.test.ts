import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { merchants, products, variants } from '../db/schema.js';
import { paise } from '../domain/money.js';
import { ValidationError } from '../domain/refusal.js';
import { createTestDatabase, type TestDatabaseHandle } from '../testSupport/pgliteDatabase.js';
import { archiveProduct } from './archiveProduct.js';
import { type IngestItem, ingestItems, productIdForSource } from './ingest.js';
import { submitCatalogItem } from './submission.js';
import type { ExtractionInput, ExtractionModel, ExtractionResult, ProductExtraction } from './types.js';

/**
 * S1.3 (issue #41): a Merchant submits from chat, against a real (embedded)
 * Postgres with a canned extractor behind the model seam.
 *
 * What is on trial is the *id policy*, because that is the whole difference
 * between this path and the dataset path — and the dataset path must not
 * notice that this one exists.
 */

const MERCHANT_ID = 'mrc_test_merchant';

const CAPTION = 'New drop 🔥 RAAT oversized tee — ₹1,199/- only. DM to order.';

function extraction(overrides: Partial<ProductExtraction> = {}): ProductExtraction {
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

function cannedModel(result: ProductExtraction, seen?: ExtractionInput[]): ExtractionModel {
  return {
    modelId: 'canned-extractor',
    extract: (input: ExtractionInput): Promise<ExtractionResult> => {
      seen?.push(input);
      return Promise.resolve({
        extraction: result,
        modelId: 'canned-extractor-2026-09-03',
        rawResponse: '{}',
      });
    },
  };
}

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

const servesJpeg: typeof fetch = (() =>
  Promise.resolve(
    new Response(JPEG, { headers: { 'content-type': 'image/jpeg' } }),
  )) as unknown as typeof fetch;

describe('submitCatalogItem', () => {
  let handle: TestDatabaseHandle;

  beforeEach(async () => {
    handle = await createTestDatabase();
    await handle.db.insert(merchants).values({ id: MERCHANT_ID, name: 'Kalaakar Streetwear' });
  });

  afterEach(async () => {
    await handle.close();
  });

  it('mints random prd_/var_ ids and a sub_ source id — never the dataset shape', async () => {
    const submitted = await submitCatalogItem(
      handle.db,
      MERCHANT_ID,
      cannedModel(extraction()),
      { caption: CAPTION },
    );

    expect(submitted.productId).toMatch(/^prd_[0-9a-f]{32}$/);
    expect(submitted.productId).not.toContain('prd_demo_');
    expect(submitted.sourceId).toMatch(/^sub_[0-9a-f]{32}$/);
    expect(submitted.status).toBe('published');
    expect(submitted.created).toBe(true);

    const rows = await handle.db
      .select()
      .from(variants)
      .where(eq(variants.productId, submitted.productId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toMatch(/^var_[0-9a-f]{32}$/);
    expect(rows[0]!.id).not.toContain('var_demo_');
  });

  it('uses the merchant\'s own sourceId as a suffix, never as the whole id', async () => {
    const submitted = await submitCatalogItem(
      handle.db,
      MERCHANT_ID,
      cannedModel(extraction()),
      { caption: CAPTION, sourceId: 'Raat Tee / Sept drop' },
    );
    expect(submitted.sourceId).toBe('sub_raat_tee_sept_drop');
  });

  it('creates TWO Products from two submissions of the same caption (no idempotency in v1)', async () => {
    const model = cannedModel(extraction());
    const first = await submitCatalogItem(handle.db, MERCHANT_ID, model, { caption: CAPTION });
    const second = await submitCatalogItem(handle.db, MERCHANT_ID, model, { caption: CAPTION });

    expect(second.productId).not.toBe(first.productId);
    expect(second.sourceId).not.toBe(first.sourceId);
    expect(second.created).toBe(true);
    const rows = await handle.db.select().from(products);
    expect(rows).toHaveLength(2);
  });

  it('holds the Product when the caption states no stock — the gate is untouched', async () => {
    const submitted = await submitCatalogItem(
      handle.db,
      MERCHANT_ID,
      cannedModel(extraction({ stock: { value: null, confidence: 0 } })),
      { caption: CAPTION },
    );
    expect(submitted.status).toBe('needs_confirmation');
    expect(submitted.holds.map((hold) => hold.field)).toEqual(['stock']);

    const rows = await handle.db
      .select()
      .from(variants)
      .where(eq(variants.productId, submitted.productId));
    // Never invented: unstated stays null.
    expect(rows[0]!.stock).toBeNull();
  });

  it('fetches imageUrl server-side and hands the bytes to the model', async () => {
    const seen: ExtractionInput[] = [];
    await submitCatalogItem(
      handle.db,
      MERCHANT_ID,
      cannedModel(extraction(), seen),
      { caption: CAPTION, imageUrl: 'https://cdn.example.com/drop.jpg' },
      { fetchImpl: servesJpeg },
    );
    expect(seen[0]!.image).toEqual({ mediaType: 'image/jpeg', base64: JPEG.toString('base64') });
    // Verbatim: the caption reaches the model exactly as the merchant wrote it.
    expect(seen[0]!.caption).toBe(CAPTION);
  });

  it('accepts inline bytes as the other image path', async () => {
    const seen: ExtractionInput[] = [];
    await submitCatalogItem(handle.db, MERCHANT_ID, cannedModel(extraction(), seen), {
      caption: CAPTION,
      imageBase64: JPEG.toString('base64'),
      imageMediaType: 'image/jpeg',
    });
    expect(seen[0]!.image).toEqual({ mediaType: 'image/jpeg', base64: JPEG.toString('base64') });
  });

  it('rejects a blank caption and both image forms at once as INVALID_SUBMISSION', async () => {
    const model = cannedModel(extraction());
    await expect(
      submitCatalogItem(handle.db, MERCHANT_ID, model, { caption: '   \n ' }),
    ).rejects.toMatchObject({ code: 'INVALID_SUBMISSION' });

    await expect(
      submitCatalogItem(handle.db, MERCHANT_ID, model, {
        caption: CAPTION,
        imageUrl: 'https://cdn.example.com/a.jpg',
        imageBase64: JPEG.toString('base64'),
        imageMediaType: 'image/jpeg',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_SUBMISSION' });

    // Nothing was written on either rejection.
    expect(await handle.db.select().from(products)).toEqual([]);
  });

  it('surfaces a refused photo link as INVALID_IMAGE, writing nothing', async () => {
    const error = await submitCatalogItem(handle.db, MERCHANT_ID, cannedModel(extraction()), {
      caption: CAPTION,
      imageUrl: 'http://169.254.169.254/latest/meta-data/',
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).code).toBe('INVALID_IMAGE');
    expect(await handle.db.select().from(products)).toEqual([]);
  });

  it('leaves the dataset path deterministic: ingest:demo still writes prd_demo_ ids', async () => {
    const item: IngestItem = {
      sourceId: '01-raat-tee',
      caption: CAPTION,
      imagePath: 'fixtures/demo-dataset/images/01-raat-tee.jpg',
      image: null,
    };
    const model = cannedModel(extraction());
    const [ingested] = await ingestItems(handle.db, MERCHANT_ID, model, [item]);
    expect(ingested!.productId).toBe(productIdForSource('01-raat-tee'));
    expect(ingested!.productId).toMatch(/^prd_demo_/);

    // …and re-running still skips rather than duplicating.
    const [again] = await ingestItems(handle.db, MERCHANT_ID, model, [item]);
    expect(again!.created).toBe(false);
    expect(await handle.db.select().from(products)).toHaveLength(1);
  });
});

describe('archiveProduct (plan D3)', () => {
  let handle: TestDatabaseHandle;

  beforeEach(async () => {
    handle = await createTestDatabase();
    await handle.db.insert(merchants).values({ id: MERCHANT_ID, name: 'Kalaakar Streetwear' });
  });

  afterEach(async () => {
    await handle.close();
  });

  it('sets a published Product back to draft, and leaves its rows intact', async () => {
    const submitted = await submitCatalogItem(
      handle.db,
      MERCHANT_ID,
      cannedModel(extraction()),
      { caption: CAPTION },
    );
    expect(submitted.status).toBe('published');

    expect(await archiveProduct(handle.db, MERCHANT_ID, submitted.productId)).toBe(true);

    const rows = await handle.db.select().from(products).where(eq(products.id, submitted.productId));
    expect(rows[0]!.status).toBe('draft');
    // The Product and its Variants are still there — archived, not deleted.
    expect(
      await handle.db.select().from(variants).where(eq(variants.productId, submitted.productId)),
    ).toHaveLength(1);
  });

  it('reports false for a Product that belongs to another merchant', async () => {
    const submitted = await submitCatalogItem(
      handle.db,
      MERCHANT_ID,
      cannedModel(extraction()),
      { caption: CAPTION },
    );
    expect(await archiveProduct(handle.db, 'mrc_someone_else', submitted.productId)).toBe(false);
  });
});
