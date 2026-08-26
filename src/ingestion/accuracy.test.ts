import { describe, expect, it } from 'vitest';
import { paise } from '../domain/money.js';
import {
  fieldInstances,
  scoreDemoItem,
  summarizeDemo,
  thresholdSweep,
  variantStockMatches,
} from './accuracy.js';
import type { DemoLabel } from './demoDataset.js';
import type { ProductExtraction } from './types.js';

/**
 * The metric behind the reportable accuracy numbers — tested like the spike's
 * scorer, because a bug here misreports the project's headline claim.
 */

const label: DemoLabel = {
  name: 'GALLI Cargo Pants',
  pricePaise: paise(189900),
  stock: null,
  variantLabels: ['28', '30', '32'],
  variantStock: { '32': 3 },
  description: 'Ripstop cargo pants.',
};

function extraction(overrides: Partial<ProductExtraction> = {}): ProductExtraction {
  return {
    name: { value: 'GALLI Cargo Pants', confidence: 0.95 },
    description: { value: 'Ripstop cargos with 8 pockets.', confidence: 0.9 },
    price: { value: paise(189900), confidence: 0.96 },
    priceText: { value: 'Rs 1,899 flat', confidence: 0.96 },
    stock: { value: null, confidence: 0 },
    variantLabels: { value: ['28', '30', '32'], confidence: 0.94 },
    variantStock: { value: { '32': 3 }, confidence: 0.92 },
    ...overrides,
  };
}

describe('scoreDemoItem', () => {
  it('scores a fully correct item as matching on every field', () => {
    const score = scoreDemoItem('04', label, extraction());
    expect(score.name.match).toBe(true);
    expect(score.price.match).toBe(true);
    expect(score.stock.match).toBe(true);
    expect(score.variantLabels.match).toBe(true);
    expect(score.descriptionPresence.match).toBe(true);
    expect(score.variantStock.match).toBe(true);
  });

  it('null stock is the CORRECT answer when the label says the caption stated none', () => {
    const invented = scoreDemoItem('04', label, extraction({ stock: { value: 13, confidence: 0.9 } }));
    expect(invented.stock.match).toBe(false);

    const honest = scoreDemoItem('04', label, extraction());
    expect(honest.stock.match).toBe(true);
  });

  it('description is scored on presence, not prose', () => {
    const differentProse = scoreDemoItem(
      '04',
      label,
      extraction({ description: { value: 'Completely different words.', confidence: 0.8 } }),
    );
    expect(differentProse.descriptionPresence.match).toBe(true);

    const missing = scoreDemoItem('04', label, extraction({ description: { value: null, confidence: 0 } }));
    expect(missing.descriptionPresence.match).toBe(false);
  });

  it('carries the confidence of each field for threshold tuning', () => {
    const score = scoreDemoItem('04', label, extraction());
    expect(score.price.confidence).toBe(0.96);
    expect(score.stock.confidence).toBe(0);
  });
});

describe('variantStockMatches', () => {
  it('matches exact maps under label normalisation', () => {
    expect(variantStockMatches({ '32': 3 }, { '32': 3 })).toBe(true);
    expect(variantStockMatches({ 'UK 7': 2 }, { 'uk 7': 2 })).toBe(true);
  });

  it('empty matches empty — the common no-per-variant-counts case', () => {
    expect(variantStockMatches({}, {})).toBe(true);
  });

  it('refuses missing keys, extra keys and wrong counts', () => {
    expect(variantStockMatches({ '32': 3 }, {})).toBe(false);
    expect(variantStockMatches({ '32': 3 }, { '32': 3, '30': 1 })).toBe(false);
    expect(variantStockMatches({ '32': 3 }, { '32': 4 })).toBe(false);
    expect(variantStockMatches({}, { '32': 3 })).toBe(false);
  });
});

describe('summarizeDemo and the threshold sweep', () => {
  const right = scoreDemoItem('a', label, extraction());
  const wrongPrice = scoreDemoItem(
    'b',
    label,
    extraction({ price: { value: paise(249900), confidence: 0.85 }, priceText: { value: '₹2,499', confidence: 0.85 } }),
  );

  it('counts per-field matches over items', () => {
    const summary = summarizeDemo([right, wrongPrice]);
    const price = summary.perField.find((f) => f.field === 'price');
    expect(price).toEqual({ field: 'price', matches: 1, items: 2, accuracy: 0.5 });
    const name = summary.perField.find((f) => f.field === 'name');
    expect(name?.matches).toBe(2);
    expect(summary.variantStock.matches).toBe(2);
  });

  it('the sweep counts wrong fields that would clear each candidate threshold', () => {
    const instances = fieldInstances([right, wrongPrice]);
    const sweep = thresholdSweep(instances, [0.8, 0.9]);

    // The wrong price claims 0.85: it clears 0.8 (bad) and is held by 0.9.
    expect(sweep[0]).toEqual(expect.objectContaining({ threshold: 0.8, wrongAtOrAbove: 1 }));
    expect(sweep[1]).toEqual(expect.objectContaining({ threshold: 0.9, wrongAtOrAbove: 0 }));
    // Correct-and-confident fields keep clearing both.
    expect(sweep[1]?.correctAtOrAbove).toBeGreaterThan(0);
  });
});
