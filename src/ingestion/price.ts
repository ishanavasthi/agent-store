import { type Paise, paise } from '../domain/money.js';

/**
 * Caption price strings → integer paise.
 *
 * The vision model reports the price *verbatim* and this turns it into money,
 * so that no LLM ever does the arithmetic (CONTEXT.md → Money). Real captions
 * write the same ₹499 a dozen ways — `₹499/-`, `Rs. 499 only`, `499 per piece`,
 * `INR 1,299.00` — and all of them are the merchant being normal, not the
 * merchant being wrong.
 *
 * Parsing is integer-only end to end: the rupee digits and the paise digits are
 * two separate integers combined as `rupees * 100 + paise`. There is no
 * `parseFloat` here and there must never be one — `parseFloat('1299.10') * 100`
 * is `129909.99999999999`.
 *
 * The strategy is "find the amounts, refuse if there is more than one" rather
 * than "clean the prose": prose around a price is unbounded (`per piece`,
 * `all sizes same`, `+ shipping`) and every cleaning rule is a guess. Two
 * distinct amounts returns null instead of picking one — choosing between
 * "MRP 2,999" and "sirf ₹1,899" is the *model's* judgement call, made before
 * this function sees anything. If the model hands over both, the extraction
 * failed and the merchant confirms it.
 */

/** One amount: digits with optional Indian/Western grouping and up to 2 decimals. */
const AMOUNT = /\d{1,3}(?:,\d{2,3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?/g;

/**
 * Returns null for anything that is not unambiguously one amount — empty input,
 * a range, `1.5k`, a size chart that slipped through. Null is a real answer
 * here (it holds the Product out of `published`), never an exception.
 */
export function parseRupeePrice(raw: string): Paise | null {
  const values = new Set<number>();

  for (const match of raw.matchAll(AMOUNT)) {
    const text = match[0];
    // `1.5k` / `2K` are shorthand this refuses rather than reads as ₹1.50.
    const next = raw[match.index + text.length];
    if (next !== undefined && /[a-z]/i.test(next)) return null;

    const [rupeeText, fractionText] = text.split('.');
    const rupees = Number.parseInt((rupeeText as string).replaceAll(',', ''), 10);
    // `.5` in a price means fifty paise, not five — pad before parsing.
    const fraction = fractionText === undefined ? 0 : Number.parseInt(fractionText.padEnd(2, '0'), 10);
    if (!Number.isSafeInteger(rupees) || !Number.isSafeInteger(fraction)) return null;

    values.add(rupees * 100 + fraction);
    if (values.size > 1) return null;
  }

  const [only] = values;
  return only === undefined ? null : paise(only);
}
