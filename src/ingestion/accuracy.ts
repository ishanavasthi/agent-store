import type { Paise } from '../domain/money.js';
import type { DemoLabel } from './demoDataset.js';
import { namesMatch, normalizeName, pricesMatch, variantLabelsMatch } from './matchers.js';
import type { ProductExtraction } from './types.js';

/**
 * Per-field accuracy of the extraction model against the demo dataset's hand
 * labels (issue #13). Pure and unit-tested apart from the runner that makes
 * the live calls — same split as the spike, because a scoring bug here
 * silently misreports the project's headline number.
 *
 * The five reportable fields are the issue's list: name, price, stock,
 * variant labels, description *presence*. `variantStock` is scored too but
 * reported as informational — it feeds the stock-completeness gate, not the
 * accuracy floor. Matching semantics are the spike's (`matchers.ts`):
 * exact-match with the one name normalisation, null a first-class correct
 * answer for stock.
 *
 * Alongside accuracy, this module runs the **threshold sweep** the
 * auto-publish threshold is tuned on (PLAN §7 S3: self-reported confidences
 * are uncalibrated, so the threshold must come from observed behaviour): for
 * each candidate threshold, how many wrong fields would have cleared it. The
 * chosen `AUTO_PUBLISH_THRESHOLD` cites the committed run's sweep.
 */

export interface FieldOutcome<T> {
  readonly expected: T;
  readonly actual: T | null;
  readonly match: boolean;
  /** The model's self-reported confidence in the actual value. */
  readonly confidence: number;
}

export interface DemoItemScore {
  readonly id: string;
  readonly name: FieldOutcome<string>;
  readonly price: FieldOutcome<Paise>;
  /** The verbatim string the price was parsed from, for the record. */
  readonly priceText: string | null;
  /** Null is the correct answer when the caption states no count (spec story 6). */
  readonly stock: FieldOutcome<number | null>;
  readonly variantLabels: FieldOutcome<readonly string[]>;
  /** Presence, not prose: did the model produce a description where one belongs? */
  readonly descriptionPresence: FieldOutcome<boolean>;
  /** Informational: per-variant stated counts, exact map equality. */
  readonly variantStock: FieldOutcome<Readonly<Record<string, number>>>;
}

export function scoreDemoItem(
  id: string,
  label: DemoLabel,
  extraction: ProductExtraction,
): DemoItemScore {
  const actualDescription = extraction.description.value;
  const actualVariantStock = extraction.variantStock.value;

  return {
    id,
    name: {
      expected: label.name,
      actual: extraction.name.value,
      match: namesMatch(label.name, extraction.name.value),
      confidence: extraction.name.confidence,
    },
    price: {
      expected: label.pricePaise,
      actual: extraction.price.value,
      match: pricesMatch(label.pricePaise, extraction.price.value),
      confidence: extraction.price.confidence,
    },
    priceText: extraction.priceText.value,
    stock: {
      expected: label.stock,
      actual: extraction.stock.value,
      match: extraction.stock.value === label.stock,
      confidence: extraction.stock.confidence,
    },
    variantLabels: {
      expected: label.variantLabels,
      actual: extraction.variantLabels.value,
      match: variantLabelsMatch(label.variantLabels, extraction.variantLabels.value),
      confidence: extraction.variantLabels.confidence,
    },
    descriptionPresence: {
      // Every hand label carries a description, but the rule is stated
      // generally: presence must agree with the label, both ways.
      expected: label.description.trim() !== '',
      actual: actualDescription !== null,
      match: (label.description.trim() !== '') === (actualDescription !== null),
      confidence: extraction.description.confidence,
    },
    variantStock: {
      expected: label.variantStock,
      actual: actualVariantStock,
      match: variantStockMatches(label.variantStock, actualVariantStock),
      confidence: extraction.variantStock.confidence,
    },
  };
}

/** Exact map equality under the shared label normalisation. `{}` matches `{}`. */
export function variantStockMatches(
  expected: Readonly<Record<string, number>>,
  actual: Readonly<Record<string, number>> | null,
): boolean {
  if (actual === null) return false;
  const expectedEntries = Object.entries(expected);
  const actualByKey = new Map(
    Object.entries(actual).map(([label, count]) => [normalizeName(label), count]),
  );
  if (actualByKey.size !== expectedEntries.length) return false;
  return expectedEntries.every(([label, count]) => actualByKey.get(normalizeName(label)) === count);
}

/** The reportable fields, in the order the issue names them. */
export const REPORTABLE_FIELDS = [
  'name',
  'price',
  'stock',
  'variantLabels',
  'descriptionPresence',
] as const;
export type ReportableField = (typeof REPORTABLE_FIELDS)[number];
export type ScoredField = ReportableField | 'variantStock';

const ALL_FIELDS: readonly ScoredField[] = [...REPORTABLE_FIELDS, 'variantStock'];

export interface FieldAccuracy {
  readonly field: ScoredField;
  readonly matches: number;
  readonly items: number;
  readonly accuracy: number;
}

export interface DemoSummary {
  readonly items: number;
  /** The five issue-named fields; the ≥ floor claim is about these. */
  readonly perField: readonly FieldAccuracy[];
  /** Reported alongside, outside the floor: feeds the stock gate, not the metric. */
  readonly variantStock: FieldAccuracy;
}

function fieldAccuracy(scores: readonly DemoItemScore[], field: ScoredField): FieldAccuracy {
  const matches = scores.filter((s) => s[field].match).length;
  return {
    field,
    matches,
    items: scores.length,
    accuracy: scores.length === 0 ? 0 : matches / scores.length,
  };
}

export function summarizeDemo(scores: readonly DemoItemScore[]): DemoSummary {
  return {
    items: scores.length,
    perField: REPORTABLE_FIELDS.map((field) => fieldAccuracy(scores, field)),
    variantStock: fieldAccuracy(scores, 'variantStock'),
  };
}

/**
 * One (item, field) pair as evidence for threshold tuning: was the model
 * right, and how sure did it claim to be.
 */
export interface FieldInstance {
  readonly id: string;
  readonly field: ScoredField;
  readonly correct: boolean;
  readonly confidence: number;
}

export function fieldInstances(scores: readonly DemoItemScore[]): FieldInstance[] {
  return scores.flatMap((score) =>
    ALL_FIELDS.map((field) => ({
      id: score.id,
      field,
      correct: score[field].match,
      confidence: score[field].confidence,
    })),
  );
}

export interface SweepPoint {
  readonly threshold: number;
  /** Wrong fields that would clear this threshold — each one a lie auto-published. */
  readonly wrongAtOrAbove: number;
  /** Correct fields that clear it — what the threshold does not needlessly hold. */
  readonly correctAtOrAbove: number;
}

/**
 * How each candidate threshold would have behaved on this run. The tuning
 * input: a usable threshold must have `wrongAtOrAbove === 0` — nothing the
 * model got wrong may skip merchant Confirmation — and should hold as little
 * correct work hostage as possible; but the chosen constant keeps margin
 * above the minimal zero-wrong point, because confidences are uncalibrated
 * and n is small (see `AUTO_PUBLISH_THRESHOLD` for the full argument).
 */
export function thresholdSweep(
  instances: readonly FieldInstance[],
  thresholds: readonly number[] = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 0.99],
): SweepPoint[] {
  return thresholds.map((threshold) => ({
    threshold,
    wrongAtOrAbove: instances.filter((i) => !i.correct && i.confidence >= threshold).length,
    correctAtOrAbove: instances.filter((i) => i.correct && i.confidence >= threshold).length,
  }));
}
