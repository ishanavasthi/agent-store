import type { z } from 'zod';
import { parseRupeePrice } from '../price.js';
import { ExtractionError, type ExtractedField, type ProductExtraction } from '../types.js';
import { type ModelPayload, modelPayloadSchema } from './payloadSchema.js';

/**
 * The payload → `ProductExtraction` boundary: where we stop trusting the model.
 *
 * The shape check is `parsePayload`; the coercions below are about *trust*, not
 * shape. Confidences get clamped, the price gets re-derived from the verbatim
 * text by our own code, a null value always ends up with confidence 0, and a
 * stock count is never invented. These rules are the reason the committed
 * gpt-5-mini run scores the way it does, so they move between files verbatim
 * and change only with a re-run behind them.
 */

/** How much of a bad payload an error message carries. Enough to recognise it. */
const SNIPPET_LENGTH = 300;

/**
 * JSON.parse + schema validation. The hard guarantee: no payload reaches
 * `toExtraction` without having matched `modelPayloadSchema`, whether or not
 * the provider claimed to enforce the schema it was handed.
 */
export function parsePayload(rawText: string): ModelPayload {
  let json: unknown;
  try {
    json = JSON.parse(rawText);
  } catch (cause) {
    throw new ExtractionError(
      `Could not parse extraction payload as JSON: ${rawText.slice(0, SNIPPET_LENGTH)}`,
      cause,
    );
  }

  const parsed = modelPayloadSchema.safeParse(json);
  if (!parsed.success) {
    // The path first: "which field" is the question a drifted payload raises,
    // and the raw snippet is what makes the answer checkable.
    const issue = parsed.error.issues[0];
    const path = issuePath(issue);
    throw new ExtractionError(
      `Extraction payload did not match the schema at \`${path}\`: ` +
        `${issue?.message ?? 'invalid payload'} — raw: ${rawText.slice(0, SNIPPET_LENGTH)}`,
      parsed.error,
    );
  }
  return parsed.data;
}

/**
 * Where the payload went wrong, as a dotted path. An unrecognised key has no
 * path of its own in zod — the issue sits at the parent object and names the
 * keys — so it gets spelled out rather than reported as `(root)`.
 */
function issuePath(issue: z.core.$ZodIssue | undefined): string {
  if (issue === undefined) return '(root)';
  const prefix = issue.path.map(String);
  if (issue.code === 'unrecognized_keys') return [...prefix, ...issue.keys].join('.');
  return prefix.length === 0 ? '(root)' : prefix.join('.');
}

/** A null value never carries confidence, whatever the model claimed. */
export function field<T>(value: T | null, confidence: unknown): ExtractedField<T> {
  if (value === null) return { value: null, confidence: 0 };
  const raw = typeof confidence === 'number' && Number.isFinite(confidence) ? confidence : 0;
  return { value, confidence: Math.min(1, Math.max(0, raw)) };
}

export function toExtraction(payload: ModelPayload): ProductExtraction {
  const priceText = payload.priceText?.value ?? null;
  const parsedPrice = priceText === null ? null : parseRupeePrice(priceText);

  return {
    name: field(nonEmpty(payload.name?.value), payload.name?.confidence),
    description: field(nonEmpty(payload.description?.value), payload.description?.confidence),
    // A price we could not parse is not a price, however sure the model was.
    price: field(parsedPrice, payload.priceText?.confidence),
    priceText: field(priceText, payload.priceText?.confidence),
    stock: field(
      typeof payload.stock?.value === 'number' && Number.isSafeInteger(payload.stock.value)
        ? payload.stock.value
        : null,
      payload.stock?.confidence,
    ),
    variantLabels: field(
      Array.isArray(payload.variantLabels?.value) ? payload.variantLabels.value : [],
      payload.variantLabels?.confidence,
    ),
    variantStock: field(
      toVariantStockRecord(payload.variantStock?.value),
      payload.variantStock?.confidence,
    ),
  };
}

/** Fold the wire pairs into the seam's record, dropping anything malformed. */
export function toVariantStockRecord(
  pairs: readonly { label: string; count: number }[] | null | undefined,
): Record<string, number> {
  const record: Record<string, number> = {};
  if (!Array.isArray(pairs)) return record;
  for (const pair of pairs) {
    const label = typeof pair.label === 'string' ? pair.label.trim() : '';
    if (label === '') continue;
    if (typeof pair.count !== 'number' || !Number.isSafeInteger(pair.count) || pair.count < 0)
      continue;
    record[label] = pair.count;
  }
  return record;
}

export function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}
