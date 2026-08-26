import { describe, expect, it } from 'vitest';
import { paise } from '../domain/money.js';
import { AUTO_PUBLISH_THRESHOLD, UNTITLED, assembleProduct } from './pipeline.js';
import type { ProductExtraction } from './types.js';

/**
 * The lifecycle gate, tested with canned extractions and no network (issue
 * #13: ingestion-logic tests use a canned extractor behind the model
 * interface). Every rule PLAN §4 states about `needs-confirmation` is a case
 * here, because each one decides whether an Agent can spend money on a
 * Product nobody confirmed.
 */

const SOURCE = {
  sourceId: '99-test-item',
  caption: 'TEST tee ₹499/- S M L',
  imagePath: 'fixtures/demo-dataset/images/99-test-item.jpg',
};

const OPTIONS = { modelId: 'canned-model', extractedAt: new Date('2026-08-26T00:00:00Z') };

/** A fully confident, fully stated extraction — the one that may publish. */
function confident(overrides: Partial<ProductExtraction> = {}): ProductExtraction {
  return {
    name: { value: 'TEST Tee', confidence: 0.97 },
    description: { value: 'A test tee.', confidence: 0.95 },
    price: { value: paise(49900), confidence: 0.97 },
    priceText: { value: '₹499/-', confidence: 0.97 },
    stock: { value: 12, confidence: 0.95 },
    variantLabels: { value: [], confidence: 0.95 },
    variantStock: { value: {}, confidence: 0.95 },
    ...overrides,
  };
}

describe('assembleProduct — publishing', () => {
  it('publishes a fully confident product with stated stock and no variants as one implicit default Variant', () => {
    const assembled = assembleProduct(SOURCE, confident(), OPTIONS);

    expect(assembled.status).toBe('published');
    expect(assembled.record.holds).toEqual([]);
    expect(assembled.variants).toEqual([
      { label: null, isDefault: true, pricePaise: 49900, stock: 12 },
    ]);
    expect(assembled.title).toBe('TEST Tee');
    expect(assembled.description).toBe('A test tee.');
  });

  it('publishes stated variants whose stock is fully stated per variant, price defaulted across all of them', () => {
    const assembled = assembleProduct(
      SOURCE,
      confident({
        stock: { value: null, confidence: 0 },
        variantLabels: { value: ['S', 'M', 'L'], confidence: 0.95 },
        variantStock: { value: { S: 4, M: 7, L: 2 }, confidence: 0.93 },
      }),
      OPTIONS,
    );

    // The MACHLI case: no product-level total is stated and none is invented,
    // but every Variant's count is — the catalog knows exactly what it can sell.
    expect(assembled.status).toBe('published');
    expect(assembled.variants).toEqual([
      { label: 'S', isDefault: false, pricePaise: 49900, stock: 4 },
      { label: 'M', isDefault: false, pricePaise: 49900, stock: 7 },
      { label: 'L', isDefault: false, pricePaise: 49900, stock: 2 },
    ]);
  });

  it('matches per-variant counts to labels through normalisation, not exact spelling', () => {
    const assembled = assembleProduct(
      SOURCE,
      confident({
        stock: { value: null, confidence: 0 },
        variantLabels: { value: ['UK 7', 'UK 8'], confidence: 0.95 },
        variantStock: { value: { 'UK7': 5, 'uk 8': 3 }, confidence: 0.95 },
      }),
      OPTIONS,
    );
    expect(assembled.variants.map((v) => v.stock)).toEqual([5, 3]);
    expect(assembled.status).toBe('published');
  });

  it('publishes at exactly the threshold — the gate is strictly below, not at-or-below', () => {
    const assembled = assembleProduct(
      SOURCE,
      confident({ name: { value: 'TEST Tee', confidence: AUTO_PUBLISH_THRESHOLD } }),
      OPTIONS,
    );
    expect(assembled.status).toBe('published');
  });
});

describe('assembleProduct — the stock rule', () => {
  it('holds a product whose caption never states stock, even with every confidence at 1.0', () => {
    const assembled = assembleProduct(
      SOURCE,
      confident({
        name: { value: 'TEST Tee', confidence: 1 },
        description: { value: 'A test tee.', confidence: 1 },
        price: { value: paise(49900), confidence: 1 },
        priceText: { value: '₹499/-', confidence: 1 },
        stock: { value: null, confidence: 0 },
        variantLabels: { value: [], confidence: 1 },
        variantStock: { value: {}, confidence: 1 },
      }),
      OPTIONS,
    );

    // THE rule: a defaulted stock number is fiction, so missing stock always
    // holds — this is what guarantees the confirmation screen in the demo.
    expect(assembled.status).toBe('needs_confirmation');
    expect(assembled.record.holds).toEqual([
      { field: 'stock', reason: 'the caption never states a stock count' },
    ]);
    expect(assembled.variants[0]?.stock).toBeNull();
  });

  it('holds a product with a stated total but no per-variant split, leaving variant stock null', () => {
    const assembled = assembleProduct(
      SOURCE,
      confident({
        stock: { value: 30, confidence: 0.95 },
        variantLabels: { value: ['black', 'grey'], confidence: 0.95 },
      }),
      OPTIONS,
    );

    // The DHUNDH case: "30 pcs total dono colour mila ke" is real information
    // (kept in the record for T13) but splitting it across colours would be
    // invention — the merchant does that on the confirmation screen.
    expect(assembled.status).toBe('needs_confirmation');
    expect(assembled.variants.map((v) => v.stock)).toEqual([null, null]);
    expect(assembled.record.fields.stock.value).toBe(30);
    expect(assembled.record.holds).toEqual([
      expect.objectContaining({ field: 'stock', reason: expect.stringContaining('no per-variant split') }),
    ]);
  });

  it('holds when only some variants have stated counts', () => {
    const assembled = assembleProduct(
      SOURCE,
      confident({
        stock: { value: null, confidence: 0 },
        variantLabels: { value: ['28', '30', '32'], confidence: 0.95 },
        variantStock: { value: { '32': 3 }, confidence: 0.95 },
      }),
      OPTIONS,
    );

    // The GALLI case: waist 32's count is real and kept; 28 and 30 are unstated.
    expect(assembled.status).toBe('needs_confirmation');
    expect(assembled.variants).toEqual([
      { label: '28', isDefault: false, pricePaise: 49900, stock: null },
      { label: '30', isDefault: false, pricePaise: 49900, stock: null },
      { label: '32', isDefault: false, pricePaise: 49900, stock: 3 },
    ]);
    expect(assembled.record.holds[0]?.reason).toContain('28, 30');
  });

  it('holds a stated count whose confidence is below threshold, but still records the value provisionally', () => {
    const assembled = assembleProduct(
      SOURCE,
      confident({ stock: { value: 12, confidence: 0.5 } }),
      OPTIONS,
    );
    expect(assembled.status).toBe('needs_confirmation');
    // Provisional, for the confirmation screen to prefill — not published.
    expect(assembled.variants[0]?.stock).toBe(12);
    expect(assembled.record.fields.stock.belowThreshold).toBe(true);
  });
});

describe('assembleProduct — below-threshold and missing fields', () => {
  it('one below-threshold field holds the whole product', () => {
    const assembled = assembleProduct(
      SOURCE,
      confident({ name: { value: 'TEST Tee', confidence: 0.6 } }),
      OPTIONS,
    );

    expect(assembled.status).toBe('needs_confirmation');
    expect(assembled.record.fields.name.belowThreshold).toBe(true);
    // The rest of the extraction is intact — no half-discarded products either.
    expect(assembled.title).toBe('TEST Tee');
    expect(assembled.variants[0]?.pricePaise).toBe(49900);
  });

  it('a missing price holds the product and leaves variant prices null, never zero', () => {
    const assembled = assembleProduct(
      SOURCE,
      confident({
        price: { value: null, confidence: 0 },
        priceText: { value: null, confidence: 0 },
      }),
      OPTIONS,
    );

    expect(assembled.status).toBe('needs_confirmation');
    expect(assembled.variants[0]?.pricePaise).toBeNull();
    expect(assembled.record.holds).toContainEqual({
      field: 'price',
      reason: 'the extraction found no price',
    });
  });

  it('a missing name holds the product under a placeholder title that says so', () => {
    const assembled = assembleProduct(
      SOURCE,
      confident({ name: { value: null, confidence: 0 } }),
      OPTIONS,
    );
    expect(assembled.status).toBe('needs_confirmation');
    expect(assembled.title).toBe(UNTITLED);
    expect(assembled.record.fields.name.value).toBeNull();
  });

  it('a missing description holds the product', () => {
    const assembled = assembleProduct(
      SOURCE,
      confident({ description: { value: null, confidence: 0 } }),
      OPTIONS,
    );
    expect(assembled.status).toBe('needs_confirmation');
    expect(assembled.description).toBeNull();
  });

  it('under-confident variant labels hold the product even when everything else is sure', () => {
    const assembled = assembleProduct(
      SOURCE,
      confident({
        stock: { value: null, confidence: 0 },
        variantLabels: { value: ['S', 'M'], confidence: 0.4 },
        variantStock: { value: { S: 1, M: 2 }, confidence: 0.95 },
      }),
      OPTIONS,
    );
    expect(assembled.status).toBe('needs_confirmation');
    expect(assembled.record.fields.variantLabels.belowThreshold).toBe(true);
  });

  it('deduplicates repeated variant labels instead of minting duplicate Variants', () => {
    const assembled = assembleProduct(
      SOURCE,
      confident({
        stock: { value: null, confidence: 0 },
        variantLabels: { value: ['M', 'L', 'm ', 'L'], confidence: 0.95 },
        variantStock: { value: { M: 3, L: 4 }, confidence: 0.95 },
      }),
      OPTIONS,
    );
    expect(assembled.variants.map((v) => v.label)).toEqual(['M', 'L']);
  });
});

describe('assembleProduct — the extraction record', () => {
  it('carries source, model, threshold and every field with its confidence', () => {
    const assembled = assembleProduct(SOURCE, confident(), OPTIONS);
    const record = assembled.record;

    expect(record.version).toBe(1);
    expect(record.sourceId).toBe('99-test-item');
    expect(record.caption).toBe(SOURCE.caption);
    expect(record.imagePath).toBe(SOURCE.imagePath);
    expect(record.modelId).toBe('canned-model');
    expect(record.extractedAt).toBe('2026-08-26T00:00:00.000Z');
    expect(record.threshold).toBe(AUTO_PUBLISH_THRESHOLD);
    expect(record.fields.price).toEqual({ value: 49900, confidence: 0.97, belowThreshold: false });
    expect(record.fields.priceText.value).toBe('₹499/-');
    expect(record.holds).toEqual([]);
  });

  it('is plain JSON — survives a jsonb round-trip unchanged', () => {
    const assembled = assembleProduct(SOURCE, confident(), OPTIONS);
    expect(JSON.parse(JSON.stringify(assembled.record))).toEqual(assembled.record);
  });
});
