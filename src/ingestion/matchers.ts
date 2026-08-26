import type { Paise } from '../domain/money.js';

/**
 * Field matchers shared by the spike scorer (S3), the demo-dataset accuracy
 * scorer (T12) and the pipeline's variant-stock label matching. Moved up from
 * `spike/scoring.ts` unchanged; the semantics they pin are the semantics every
 * accuracy number in this repo is computed under.
 *
 * **Exact-match, with one normalisation.** Price is integer-paise equality with
 * nothing forgiven. Name is string equality after case-folding, punctuation
 * removal and whitespace collapse, so `"SABR" Oversized Tee` and
 * `SABR Oversized Tee` both normalise to `sabr oversized tee` and count as the
 * same answer, while `Sabr Oversized T-Shirt` normalises to
 * `sabr oversized t shirt` and does not — punctuation becomes a space rather
 * than vanishing, so a different word stays a different word. Nothing else is
 * forgiven: no synonym list, no substring credit, no fuzzy distance. The
 * normalisation exists because punctuation is a transcription artifact of the
 * caption, not a reading of it.
 */

/** Case, punctuation and spacing are transcription noise; word choice is not. */
export function normalizeName(raw: string): string {
  return raw
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function namesMatch(expected: string, actual: string | null): boolean {
  return actual !== null && normalizeName(expected) === normalizeName(actual);
}

/** Integer paise equality. Nothing is rounded, nothing is within-tolerance. */
export function pricesMatch(expected: Paise, actual: Paise | null): boolean {
  return actual !== null && actual === expected;
}

/** Order-insensitive: `["M","L"]` and `["L","M"]` are the same set of sizes. */
export function variantLabelsMatch(
  expected: readonly string[],
  actual: readonly string[] | null,
): boolean {
  if (actual === null || actual.length !== expected.length) return false;
  const normalized = new Set(actual.map(normalizeName));
  return expected.every((label) => normalized.has(normalizeName(label)));
}
