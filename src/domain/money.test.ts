import { describe, expect, it } from 'vitest';
import { MoneyError, formatPaise, isPaise, moneyView, multiplyPaise, paise } from './money.js';

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
    expect(isPaise(-1)).toBe(false);
    expect(isPaise(null)).toBe(false);
  });
});

describe('multiplyPaise', () => {
  it('multiplies by quantity', () => {
    expect(multiplyPaise(paise(129900), 3)).toBe(389700);
    expect(multiplyPaise(paise(129900), 1)).toBe(129900);
    expect(multiplyPaise(paise(129900), 0)).toBe(0);
  });

  it('rejects a fractional or negative quantity', () => {
    expect(() => multiplyPaise(paise(100), 1.5)).toThrow(MoneyError);
    expect(() => multiplyPaise(paise(100), -1)).toThrow(MoneyError);
  });

  it('stays exact where naive rupee maths would drift', () => {
    // 0.07 * 3 in rupees is 0.21000000000000002 as a float.
    expect(multiplyPaise(paise(7), 3)).toBe(21);
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

describe('moneyView', () => {
  it('bundles the amount, its display form and the currency', () => {
    expect(moneyView(paise(129900))).toEqual({
      amountPaise: 129900,
      amountDisplay: '₹1,299.00',
      currency: 'INR',
    });
  });
});
