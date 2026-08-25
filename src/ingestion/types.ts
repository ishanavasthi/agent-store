import type { Paise } from '../domain/money.js';

/**
 * The extraction-model seam (spec "Injected seam #2", PLAN §7 S3).
 *
 * Everything above this interface — the M4 ingestion pipeline, its confidence
 * gating, its variant defaulting — sees only `ExtractionModel`. Two
 * implementations are expected:
 *   - `OpenAIExtractionModel` (this ticket) — a vision model over the real API.
 *   - a canned extractor (T12) returning fixed `ProductExtraction` values, so
 *     ingestion-logic tests never touch the network.
 *
 * Which OpenAI model runs is a *parameter of the implementation*, not a
 * property of the seam: stepping gpt-5-mini → gpt-5 for the S3 gate is the
 * `EXTRACTION_MODEL` environment variable (spec story 42 — a config change, not
 * a refactor), and no source file moves.
 *
 * **The model does not compute money.** It reports the price *verbatim as the
 * caption wrote it* (`priceText`), and deterministic code in `price.ts` turns
 * that into integer paise. So the model's job is the judgement call — which of
 * the two numbers in "MRP 2999 ab sirf 1899/-" is the sellable price — while
 * the arithmetic stays in tested code, per CONTEXT.md → Money.
 */

/**
 * One extracted field with the model's own confidence in it.
 *
 * `confidence` is **self-reported by the model and its calibration is
 * unverified** — it is not a probability derived from logprobs. It is good
 * enough for its actual job (ranking which fields to put in front of the
 * merchant for Confirmation) and must not be read as anything stronger.
 * `value: null` means the model found nothing, and always carries confidence 0.
 */
export interface ExtractedField<T> {
  readonly value: T | null;
  /** 0–1, clamped on the way in. Self-reported; see above. */
  readonly confidence: number;
}

/**
 * What one photo+caption yields. Deliberately flatter than the catalog schema:
 * turning this into Products and Variants — defaulting the single caption price
 * across the size labels, minting the implicit default Variant when
 * `variantLabels` is empty — is the pipeline's job (T12), not the model's.
 */
export interface ProductExtraction {
  /** The product title a merchant would list, e.g. `SABR Oversized Tee`. */
  readonly name: ExtractedField<string>;
  readonly description: ExtractedField<string>;
  /** Integer paise, parsed by us from `priceText`. Never a float. */
  readonly price: ExtractedField<Paise>;
  /** The price string exactly as the caption wrote it, e.g. `₹1,299/-`. */
  readonly priceText: ExtractedField<string>;
  /**
   * Units in stock. Null when the caption never stated a number — which is the
   * common case and is *required* to hold the Product out of `published`
   * (spec story 6). "Stock ready ✅" is not a number.
   */
  readonly stock: ExtractedField<number>;
  /**
   * Size/colour labels as written, e.g. `["S", "M", "L", "XL"]`. Empty means
   * the caption stated none, which becomes one implicit default Variant.
   */
  readonly variantLabels: ExtractedField<readonly string[]>;
}

export interface ExtractionImage {
  /** e.g. `image/jpeg`. */
  readonly mediaType: string;
  readonly base64: string;
}

export interface ExtractionInput {
  /** The merchant's original caption, Hinglish and emoji intact. */
  readonly caption: string;
  /** Null exercises the caption-only path (the K2 fallback format). */
  readonly image: ExtractionImage | null;
}

export interface ExtractionResult {
  readonly extraction: ProductExtraction;
  /**
   * The model id the provider says actually served the request — usually the
   * dated snapshot behind the alias in `ExtractionModel.modelId`, which is the
   * form worth writing into an audit payload or a spike run record.
   */
  readonly modelId: string;
  /** Raw JSON the model emitted, kept so a spike run can be re-scored later. */
  readonly rawResponse: string;
}

export class ExtractionError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ExtractionError';
  }
}

export interface ExtractionModel {
  /** The model this implementation was configured to call, e.g. `gpt-5-mini`. */
  readonly modelId: string;

  extract(input: ExtractionInput): Promise<ExtractionResult>;
}
