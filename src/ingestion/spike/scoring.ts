import { type Paise, paise } from '../../domain/money.js';
import { namesMatch, pricesMatch, variantLabelsMatch } from '../matchers.js';
import type { ProductExtraction } from '../types.js';

export { namesMatch, normalizeName, pricesMatch, variantLabelsMatch } from '../matchers.js';

/**
 * Scoring for spike S3 (PLAN §7): name + price exact-match against hand labels.
 *
 * Pure and unit-tested, separately from the runner that makes the live calls,
 * so the metric that decides kill criterion K2 is itself checked by CI rather
 * than trusted. A scoring bug here would fire — or fail to fire — K2 wrongly.
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

/**
 * One hand label from `fixtures/extraction-spike/dataset.json`, after
 * `parseSpikeLabel` has vouched for it.
 */
export interface SpikeLabel {
  readonly name: string;
  readonly pricePaise: Paise;
  readonly stock: number | null;
  readonly variantLabels: readonly string[];
}

/**
 * The dataset boundary: a label's price becomes `Paise` here or the run dies.
 *
 * A hand label is hand-typed, so it is exactly where a rupee-typo (`1299` for
 * `129900`) or a stray decimal gets in — and a bad label does not fail loudly,
 * it silently scores every model as wrong and would fire K2 on a typo. Money
 * crosses into this program through `paise()` the same way it does in
 * `domain/catalog.ts` and `gateway/razorpayGateway.ts`.
 */
export function parseSpikeLabel(raw: {
  readonly name: string;
  readonly pricePaise: number;
  readonly stock: number | null;
  readonly variantLabels: readonly string[];
}): SpikeLabel {
  return {
    name: raw.name,
    pricePaise: paise(raw.pricePaise),
    stock: raw.stock,
    variantLabels: raw.variantLabels,
  };
}

export interface FieldOutcome<T> {
  readonly expected: T;
  readonly actual: T | null;
  readonly match: boolean;
}

export interface ItemScore {
  readonly id: string;
  readonly name: FieldOutcome<string>;
  readonly price: FieldOutcome<Paise>;
  /** The price string the model copied out of the caption, for the record. */
  readonly priceText: string | null;
  /** The S3 metric: an item counts only when BOTH name and price are right. */
  readonly nameAndPrice: boolean;
  /** Reported but not part of the S3 gate; informs the M4 confidence design. */
  readonly stock: FieldOutcome<number | null>;
  readonly variantLabels: FieldOutcome<readonly string[]>;
  readonly nameConfidence: number;
  readonly priceConfidence: number;
}

export interface SpikeSummary {
  readonly items: number;
  readonly nameMatches: number;
  readonly priceMatches: number;
  readonly nameAndPriceMatches: number;
  readonly stockMatches: number;
  readonly variantMatches: number;
  /** `nameAndPriceMatches / items`, the number K2 is decided on. */
  readonly nameAndPriceAccuracy: number;
}

export function scoreItem(id: string, label: SpikeLabel, extraction: ProductExtraction): ItemScore {
  const actualVariants = extraction.variantLabels.value;

  return {
    id,
    name: {
      expected: label.name,
      actual: extraction.name.value,
      match: namesMatch(label.name, extraction.name.value),
    },
    price: {
      expected: label.pricePaise,
      actual: extraction.price.value,
      match: pricesMatch(label.pricePaise, extraction.price.value),
    },
    priceText: extraction.priceText.value,
    nameAndPrice:
      namesMatch(label.name, extraction.name.value) &&
      pricesMatch(label.pricePaise, extraction.price.value),
    stock: {
      expected: label.stock,
      actual: extraction.stock.value,
      // Null is a *correct answer* when the caption stated no count — the whole
      // point of spec story 6 is that "unstated" must not become a number.
      match: extraction.stock.value === label.stock,
    },
    variantLabels: {
      expected: label.variantLabels,
      actual: actualVariants,
      match: variantLabelsMatch(label.variantLabels, actualVariants),
    },
    nameConfidence: extraction.name.confidence,
    priceConfidence: extraction.price.confidence,
  };
}

export function summarize(scores: readonly ItemScore[]): SpikeSummary {
  const count = (predicate: (score: ItemScore) => boolean): number =>
    scores.filter(predicate).length;

  const nameAndPriceMatches = count((s) => s.nameAndPrice);

  return {
    items: scores.length,
    nameMatches: count((s) => s.name.match),
    priceMatches: count((s) => s.price.match),
    nameAndPriceMatches,
    stockMatches: count((s) => s.stock.match),
    variantMatches: count((s) => s.variantLabels.match),
    nameAndPriceAccuracy: scores.length === 0 ? 0 : nameAndPriceMatches / scores.length,
  };
}
