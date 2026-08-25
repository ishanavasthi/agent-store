import { describe, expect, it } from 'vitest';
import { paise } from '../../domain/money.js';
import type { ProductExtraction } from '../types.js';
import { namesMatch, normalizeName, pricesMatch, scoreItem, summarize } from './scoring.js';

/**
 * The metric that decides kill criterion K2 gets tested like anything else that
 * can silently change a decision.
 */

function extraction(overrides: Partial<ProductExtraction> = {}): ProductExtraction {
  return {
    name: { value: 'SABR Oversized Tee', confidence: 0.9 },
    description: { value: 'Heavyweight cotton tee.', confidence: 0.8 },
    price: { value: paise(129900), confidence: 0.95 },
    priceText: { value: '₹1,299/-', confidence: 0.95 },
    stock: { value: 12, confidence: 0.9 },
    variantLabels: { value: ['S', 'M', 'L', 'XL'], confidence: 0.9 },
    ...overrides,
  };
}

const label = {
  name: 'SABR Oversized Tee',
  pricePaise: 129900,
  stock: 12,
  variantLabels: ['S', 'M', 'L', 'XL'],
};

describe('normalizeName', () => {
  it('folds away punctuation, case and spacing', () => {
    expect(normalizeName('"SABR"  Oversized Tee')).toBe('sabr oversized tee');
    expect(normalizeName('Sabr Oversized-Tee')).toBe('sabr oversized tee');
  });

  it('does not fold away a different word', () => {
    expect(normalizeName('Sabr Oversized T-Shirt')).not.toBe(normalizeName('SABR Oversized Tee'));
  });
});

describe('namesMatch', () => {
  it('forgives transcription, not word choice', () => {
    expect(namesMatch('SABR Oversized Tee', '"Sabr" oversized tee')).toBe(true);
    expect(namesMatch('SABR Oversized Tee', 'Sabr Oversized T-Shirt')).toBe(false);
    expect(namesMatch('SABR Oversized Tee', 'Oversized Tee')).toBe(false);
  });

  it('counts a missing name as a miss', () => {
    expect(namesMatch('SABR Oversized Tee', null)).toBe(false);
  });
});

describe('pricesMatch', () => {
  it('is integer-paise equality with no tolerance', () => {
    expect(pricesMatch(129900, paise(129900))).toBe(true);
    expect(pricesMatch(129900, paise(129901))).toBe(false);
    expect(pricesMatch(129900, null)).toBe(false);
  });
});

describe('scoreItem', () => {
  it('counts an item only when name AND price are both right', () => {
    expect(scoreItem('x', label, extraction()).nameAndPrice).toBe(true);

    const wrongPrice = scoreItem('x', label, extraction({
      price: { value: paise(299900), confidence: 0.9 },
    }));
    expect(wrongPrice.name.match).toBe(true);
    expect(wrongPrice.nameAndPrice).toBe(false);
  });

  it('scores an unstated stock correct only when the label says unstated', () => {
    // Spec story 6: "unstated" must survive as null, not become a number.
    const unstated = { ...label, stock: null };
    expect(scoreItem('x', unstated, extraction({ stock: { value: null, confidence: 0 } })).stock.match).toBe(true);
    expect(scoreItem('x', unstated, extraction({ stock: { value: 2, confidence: 0.6 } })).stock.match).toBe(false);
  });

  it('compares variant labels as a set, not a sequence', () => {
    const reordered = scoreItem('x', label, extraction({
      variantLabels: { value: ['XL', 'S', 'L', 'M'], confidence: 0.9 },
    }));
    expect(reordered.variantLabels.match).toBe(true);
  });
});

describe('summarize', () => {
  it('reports accuracy as matched items over total', () => {
    const scores = [
      scoreItem('a', label, extraction()),
      scoreItem('b', label, extraction({ price: { value: paise(1), confidence: 0.1 } })),
    ];
    const summary = summarize(scores);
    expect(summary.items).toBe(2);
    expect(summary.nameAndPriceMatches).toBe(1);
    expect(summary.nameAndPriceAccuracy).toBe(0.5);
  });

  it('reports zero rather than dividing by zero on an empty run', () => {
    expect(summarize([]).nameAndPriceAccuracy).toBe(0);
  });
});
