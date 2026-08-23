import { describe, expect, it } from 'vitest';
import {
  MoneyError,
  formatPaise,
  isPaise,
  multiplyPaise,
  paise,
  parseRupeesToPaise,
  sumPaise,
} from './money.js';

describe('paise', () => {
  it('accepts non-negative integers', () => {
    expect(paise(0)).toBe(0);
    expect(paise(129900)).toBe(129900);
  });

  it.each([49.9, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2])(
    'rejects %p',
    (value) => {
      expect(() => paise(value)).toThrow(MoneyError);
    },
  );

  it('rejects rupee-shaped floats that a decimal price would produce', () => {
    // The exact bug the integer-paise rule exists to prevent.
    expect(() => paise(499.0 * 1.18)).toThrow(MoneyError);
  });

  it('narrows with isPaise', () => {
    expect(isPaise(100)).toBe(true);
    expect(isPaise('100')).toBe(false);
    expect(isPaise(1.5)).toBe(false);
  });
});

describe('sumPaise / multiplyPaise', () => {
  it('sums line amounts exactly', () => {
    expect(sumPaise([paise(49900), paise(129900), paise(1)])).toBe(179801);
  });

  it('sums an empty basket to zero', () => {
    expect(sumPaise([])).toBe(0);
  });

  it('multiplies by quantity', () => {
    expect(multiplyPaise(paise(129900), 3)).toBe(389700);
    expect(multiplyPaise(paise(129900), 0)).toBe(0);
  });

  it('rejects a fractional quantity', () => {
    expect(() => multiplyPaise(paise(100), 1.5)).toThrow(MoneyError);
  });

  it('has no float drift where naive rupee maths would', () => {
    // 0.07 + 0.01 in rupees is 0.08000000000000002 as a float.
    expect(sumPaise([paise(7), paise(1)])).toBe(8);
  });
});

describe('formatPaise', () => {
  it.each([
    [0, '₹0.00'],
    [1, '₹0.01'],
    [50, '₹0.50'],
    [49900, '₹499.00'],
    [129900, '₹1,299.00'],
    [129950, '₹1,299.50'],
  ])('formats %i paise as %s', (input, expected) => {
    expect(formatPaise(paise(input))).toBe(expected);
  });

  it('uses Indian digit grouping above one lakh', () => {
    expect(formatPaise(paise(12345678))).toBe('₹1,23,456.78');
    expect(formatPaise(paise(1234567890))).toBe('₹1,23,45,678.90');
  });
});

describe('parseRupeesToPaise', () => {
  it.each([
    ['499', 49900],
    ['499.00', 49900],
    ['499.5', 49950],
    ['499.05', 49905],
    ['₹1,299.00', 129900],
    ['  1299 ', 129900],
    ['0.07', 7],
  ])('parses %s to %i paise', (input, expected) => {
    expect(parseRupeesToPaise(input)).toBe(expected);
  });

  it('round-trips through formatPaise', () => {
    for (const amount of [0, 1, 7, 49900, 129950, 12345678]) {
      expect(parseRupeesToPaise(formatPaise(paise(amount)))).toBe(amount);
    }
  });

  it.each(['', 'free', '499.999', '-499', '4 9 9x'])('rejects %p', (input) => {
    expect(() => parseRupeesToPaise(input)).toThrow(MoneyError);
  });
});
