import type { Paise } from '../domain/money.js';
import type { HoldReason, ProductExtractionRecord, RecordedField } from './extractionRecord.js';
import { normalizeName } from './matchers.js';
import type { ExtractedField, ProductExtraction } from './types.js';

/**
 * The M4 ingestion pipeline's core: one extraction → one assembled Product
 * with Variants, per-field confidence, and a lifecycle verdict. Pure — no
 * model call, no database — so every gating rule is testable with a canned
 * extraction and no network (issue #13's split: logic tests canned, accuracy
 * pinned to the real model).
 *
 * The lifecycle gate is at Product level (PLAN §4): ONE below-threshold or
 * missing field holds the WHOLE Product in `needs-confirmation` — there are no
 * half-visible products (CONTEXT.md → Published). Held Products still carry
 * their best extracted values (that is what T13's confirmation screen
 * prefills); what they never carry is an *invented* number in a column
 * checkout trusts.
 *
 * Stock is the strict one. "Missing stock always blocks publishing — a
 * defaulted stock number would be fiction in exactly the field the
 * rule-auditor reasons about" (PLAN §4). Concretely: every Variant must get
 * its stock from a count the caption *states* —
 *   - no stated variants → the implicit default Variant carries the stated
 *     product-level count;
 *   - stated variants with per-variant counts ("S: 4 | M: 7 | L: 2") → each
 *     Variant carries its own stated count;
 *   - stated variants with only a product-level total ("30 pcs total dono
 *     colour mila ke") → the total is real information (recorded for the
 *     confirmation screen) but the per-variant split is NOT stated, and
 *     inventing one would put fiction into the exact numbers the oversell
 *     check enforces — so the Product is held until the merchant splits it.
 * Any Variant whose stock is unstated holds the Product.
 */

/**
 * The auto-publish threshold: a field publishes without merchant Confirmation
 * only at/above this self-reported confidence.
 *
 * Tuned on observed behaviour, not trusted from the model (PLAN §7 S3 caveat:
 * self-reported confidences are uncalibrated). Evidence, all in the committed
 * run's threshold sweep (`fixtures/demo-dataset/runs/gpt-5-mini.json`): on
 * that run the single wrong field — a photo-derived name — claimed 0.70, so
 * anything ≥ 0.75 blocks everything observed-wrong; but earlier prompt
 * iterations during T12 produced wrong names claiming as high as 0.95, which
 * is the S3 caveat in action — confidence barely separates right from wrong
 * on this model. So: 0.90 rather than the minimal 0.75, blocking the observed
 * miss with margin while still letting the confident core fields (0.90–0.98
 * on correct name/price) publish; on the committed run the difference costs
 * only 4 correct field-instances versus 0.80. n=28, one model: a demo-tuned
 * knob, not a calibration claim — the *hard* protection for money stays the
 * stock rule and payment-time verification, never this number.
 */
export const AUTO_PUBLISH_THRESHOLD = 0.9;

/** Where a caption+photo came from, carried through to the extraction record. */
export interface SourceItem {
  readonly sourceId: string;
  readonly caption: string;
  /** Repo-relative photo path; null for caption-only input. */
  readonly imagePath: string | null;
}

/** One Variant row to be, in the schema's nullable-until-confirmed shape. */
export interface AssembledVariant {
  readonly label: string | null;
  readonly isDefault: boolean;
  /** The caption's single price, defaulted across every Variant. Null = unstated. */
  readonly pricePaise: Paise | null;
  /** Null = the caption never stated a count for this Variant — never defaulted. */
  readonly stock: number | null;
}

export interface AssembledProduct {
  readonly sourceId: string;
  readonly title: string;
  readonly description: string | null;
  readonly status: 'needs_confirmation' | 'published';
  readonly variants: readonly AssembledVariant[];
  readonly record: ProductExtractionRecord;
}

export interface AssembleOptions {
  /** The dated snapshot that served the extraction, for the record. */
  readonly modelId: string;
  readonly extractedAt: Date;
  readonly threshold?: number;
}

/** A held Product still needs a non-null title row; this is it, and it reads as what it is. */
export const UNTITLED = 'Untitled product (needs confirmation)';

export function assembleProduct(
  source: SourceItem,
  extraction: ProductExtraction,
  options: AssembleOptions,
): AssembledProduct {
  const threshold = options.threshold ?? AUTO_PUBLISH_THRESHOLD;
  const holds: HoldReason[] = [];

  // The value-bearing fields every listing needs: absent → hold, present but
  // under-confident → hold. (A null value always carries confidence 0, so the
  // confidence check alone would catch it — the split exists so the merchant
  // reads "not found" rather than a meaningless "0.00 below threshold".)
  requireConfident(holds, 'name', extraction.name, threshold, 'product name');
  requireConfident(holds, 'description', extraction.description, threshold, 'description');
  requireConfident(holds, 'price', extraction.price, threshold, 'price');

  if (extraction.variantLabels.confidence < threshold) {
    holds.push({
      field: 'variantLabels',
      reason: `variant labels extracted at confidence ${fmt(extraction.variantLabels.confidence)}, below the ${fmt(threshold)} threshold`,
    });
  }

  const labels = dedupeLabels(extraction.variantLabels.value ?? []);
  const variants = assembleVariants(labels, extraction, threshold, holds);

  const status: AssembledProduct['status'] =
    holds.length === 0 &&
    // Belt on top of the hold logic: nothing publishes with a null in a column
    // checkout trusts, even if a future edit to the rules above forgets one.
    variants.every((v) => v.pricePaise !== null && v.stock !== null)
      ? 'published'
      : 'needs_confirmation';

  const below = new Set(holds.map((h) => h.field));
  const record: ProductExtractionRecord = {
    version: 1,
    sourceId: source.sourceId,
    imagePath: source.imagePath,
    caption: source.caption,
    modelId: options.modelId,
    extractedAt: options.extractedAt.toISOString(),
    threshold,
    fields: {
      name: recorded(extraction.name, below.has('name')),
      description: recorded(extraction.description, below.has('description')),
      price: recorded(extraction.price, below.has('price')),
      priceText: recorded(extraction.priceText, below.has('price')),
      stock: recorded(extraction.stock, below.has('stock')),
      variantLabels: recorded(
        mapValue(extraction.variantLabels, (v) => [...v]),
        below.has('variantLabels'),
      ),
      variantStock: recorded(
        mapValue(extraction.variantStock, (v) => ({ ...v })),
        below.has('variantStock'),
      ),
    },
    holds,
  };

  return {
    sourceId: source.sourceId,
    title: extraction.name.value ?? UNTITLED,
    description: extraction.description.value,
    status,
    variants,
    record,
  };
}

/**
 * Stock resolution — the one place the "never default a count" rule lives.
 * Variants carry the caption's stated counts or null, and every null is a
 * hold. The caption's single price defaults across all Variants (the caption
 * states one price for the product; that IS the per-variant price, not a
 * guess).
 */
function assembleVariants(
  labels: readonly string[],
  extraction: ProductExtraction,
  threshold: number,
  holds: HoldReason[],
): AssembledVariant[] {
  const price = extraction.price.value;
  const stock = extraction.stock;
  const variantStock = extraction.variantStock;

  // An under-confident stated count is still a hold even where the value gets
  // written provisionally: the merchant confirms it before anyone can buy.
  if (stock.value !== null && stock.confidence < threshold) {
    holds.push({
      field: 'stock',
      reason: `stock ${String(stock.value)} extracted at confidence ${fmt(stock.confidence)}, below the ${fmt(threshold)} threshold`,
    });
  }
  const perVariantStated = Object.keys(variantStock.value ?? {}).length > 0;
  if (perVariantStated && variantStock.confidence < threshold) {
    holds.push({
      field: 'variantStock',
      reason: `per-variant stock extracted at confidence ${fmt(variantStock.confidence)}, below the ${fmt(threshold)} threshold`,
    });
  }

  if (labels.length === 0) {
    // No stated choice → one implicit default Variant (CONTEXT.md → Variant),
    // carrying the product-level stated count if there is one.
    if (stock.value === null) {
      holds.push({ field: 'stock', reason: 'the caption never states a stock count' });
    }
    return [{ label: null, isDefault: true, pricePaise: price, stock: stock.value }];
  }

  // Stated variants: stock only from stated per-variant counts. Matching goes
  // one step past the scorers' normalisation and drops internal spaces too —
  // the model writes both the labels and the counts' keys from the same
  // caption, and "UK 10" vs "UK10" must not silently lose a stated count.
  const counts = new Map<string, number>();
  for (const [key, count] of Object.entries(variantStock.value ?? {})) {
    counts.set(stockKey(key), count);
  }

  const assembled = labels.map((label) => ({
    label,
    isDefault: false,
    pricePaise: price,
    stock: counts.get(stockKey(label)) ?? null,
  }));

  const unstated = assembled.filter((v) => v.stock === null).map((v) => v.label);
  if (unstated.length > 0) {
    holds.push({
      field: 'stock',
      reason:
        stock.value !== null
          ? `the caption states a total of ${String(stock.value)} across variants but no per-variant split — splitting it would be invention, the merchant has to`
          : `no stock stated for variant${unstated.length === 1 ? '' : 's'} ${unstated.join(', ')}`,
    });
  }

  return assembled;
}

function requireConfident(
  holds: HoldReason[],
  field: string,
  extracted: ExtractedField<unknown>,
  threshold: number,
  what: string,
): void {
  if (extracted.value === null) {
    holds.push({ field, reason: `the extraction found no ${what}` });
  } else if (extracted.confidence < threshold) {
    holds.push({
      field,
      reason: `${what} extracted at confidence ${fmt(extracted.confidence)}, below the ${fmt(threshold)} threshold`,
    });
  }
}

function recorded<T>(extracted: ExtractedField<T>, belowThreshold: boolean): RecordedField<T> {
  return { value: extracted.value, confidence: extracted.confidence, belowThreshold };
}

function mapValue<T, U>(extracted: ExtractedField<T>, map: (value: T) => U): ExtractedField<U> {
  return { value: extracted.value === null ? null : map(extracted.value), confidence: extracted.confidence };
}

function stockKey(label: string): string {
  return normalizeName(label).replaceAll(' ', '');
}

function dedupeLabels(labels: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of labels) {
    const label = raw.trim();
    if (label === '') continue;
    const key = normalizeName(label);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(label);
  }
  return out;
}

function fmt(confidence: number): string {
  return confidence.toFixed(2);
}
