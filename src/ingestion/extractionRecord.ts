/**
 * What ingestion remembers about how a Product's fields were extracted — the
 * jsonb payload stored at `products.extraction` and the thing T13's merchant
 * confirmation screen renders: every field's extracted value, the model's
 * self-reported confidence in it, whether it cleared the auto-publish
 * threshold, and — for a held Product — the exact reasons it is being held.
 *
 * A plain-JSON shape on purpose (no `Paise` brand, no `readonly` maps): it
 * round-trips through jsonb, so it is stated in the types jsonb can actually
 * hold. Money in here is integer paise like everywhere else; it is *display
 * and audit* data, never an input to arithmetic — the numbers checkout trusts
 * live in the `variants` columns.
 */

/** One extracted field as recorded: the value, the confidence, the verdict. */
export interface RecordedField<T> {
  readonly value: T | null;
  /** Self-reported by the model, 0–1. Not calibrated (PLAN §7 S3); ranked, not trusted. */
  readonly confidence: number;
  /** True when this field alone is enough to hold the Product out of `published`. */
  readonly belowThreshold: boolean;
}

/** Why a Product is sitting in `needs-confirmation`, one entry per cause. */
export interface HoldReason {
  /** The field the merchant needs to look at, e.g. `stock`, `price`, `variantStock`. */
  readonly field: string;
  readonly reason: string;
}

export interface ProductExtractionRecord {
  readonly version: 1;
  /** The dataset item this Product came from, e.g. `04-galli-cargo-pants`. */
  readonly sourceId: string;
  /** Repo-relative photo path, for the confirmation screen. Null on caption-only input. */
  readonly imagePath: string | null;
  /** The merchant's original caption, verbatim — what every value is judged against. */
  readonly caption: string;
  /** The dated model snapshot that served the extraction, e.g. `gpt-5-mini-2025-08-07`. */
  readonly modelId: string;
  readonly extractedAt: string;
  /** The auto-publish threshold this Product was gated against. */
  readonly threshold: number;
  readonly fields: {
    readonly name: RecordedField<string>;
    readonly description: RecordedField<string>;
    /** Integer paise, parsed by our code from `priceText`, never by the model. */
    readonly price: RecordedField<number>;
    /** The price string verbatim as the caption wrote it. */
    readonly priceText: RecordedField<string>;
    /** Product-level stated count. Null when the caption never stated one. */
    readonly stock: RecordedField<number>;
    readonly variantLabels: RecordedField<string[]>;
    /** Per-variant stated counts, keyed by variant label. `{}` when none stated. */
    readonly variantStock: RecordedField<Record<string, number>>;
  };
  /** Empty exactly when the Product auto-published. */
  readonly holds: HoldReason[];
}
