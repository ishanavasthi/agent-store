import { describe, expect, it } from 'vitest';
import { parseRupeePrice } from './price.js';

describe('parseRupeePrice', () => {
  it('reads the price formats real captions actually use', () => {
    // Every one of these is lifted from the shape of a real Instagram caption.
    expect(parseRupeePrice('₹1,299/-')).toBe(129900);
    expect(parseRupeePrice('Rs. 449/-')).toBe(44900);
    expect(parseRupeePrice('Rs 1,499')).toBe(149900);
    expect(parseRupeePrice('₹599/- only')).toBe(59900);
    expect(parseRupeePrice('INR 899.00')).toBe(89900);
    expect(parseRupeePrice('499')).toBe(49900);
    expect(parseRupeePrice('₹499 per piece')).toBe(49900);
  });

  it('treats a lone decimal digit as tens of paise, not units', () => {
    // ₹499.5 is four hundred ninety-nine rupees fifty paise.
    expect(parseRupeePrice('₹499.5')).toBe(49950);
    expect(parseRupeePrice('₹499.05')).toBe(49905);
  });

  it('never lands on a float', () => {
    // parseFloat('1299.10') * 100 is 129909.99999999999.
    expect(parseRupeePrice('₹1,299.10')).toBe(129910);
    expect(Number.isSafeInteger(parseRupeePrice('₹1,299.10'))).toBe(true);
  });

  it('refuses two different amounts rather than guessing which is sellable', () => {
    expect(parseRupeePrice('MRP 2,999 sirf ₹1,899/-')).toBeNull();
    expect(parseRupeePrice('₹999 - ₹1,499')).toBeNull();
  });

  it('accepts the same amount written twice', () => {
    expect(parseRupeePrice('₹499 (499 only)')).toBe(49900);
  });

  it('refuses shorthand it would otherwise misread by a factor of a thousand', () => {
    expect(parseRupeePrice('1.5k')).toBeNull();
    expect(parseRupeePrice('2K')).toBeNull();
  });

  it('returns null, not an error, when there is no amount at all', () => {
    // Null is a real answer: it holds the Product out of `published`.
    expect(parseRupeePrice('DM for price')).toBeNull();
    expect(parseRupeePrice('')).toBeNull();
  });
});
