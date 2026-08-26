import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Database, Executor } from '../db/client.js';
import { products, variants, type ProductStatus } from '../db/schema.js';
import type { ConfirmationStamp, ProductExtractionRecord } from '../ingestion/extractionRecord.js';
import { normalizeName } from '../ingestion/matchers.js';
import { newId } from './ids.js';
import { ValidationError } from './refusal.js';

/**
 * The merchant Confirmation seam (T13, issue #14): reading what ingestion held
 * in `needs-confirmation` and — on the merchant's explicit answer — publishing
 * it in one transaction.
 *
 * The submission is the *complete final state* of the Product: title,
 * description, and every Variant with a stated price and stock. That shape is
 * what makes "nothing unconfirmed is ever published" enforceable by the SERVER
 * rather than trusted to the UI — there is no way to publish while leaving a
 * held field unanswered, because an unanswered field is a missing value and the
 * submission does not parse. Every check here throws `ValidationError`, never
 * `Refusal`: a Refusal is the trust layer telling a *buyer* no on the money
 * path (CONTEXT.md → Failure vocabulary); this seam faces the Merchant.
 *
 * No audit event is written. Deliberate, and consistent with T12: ingestion's
 * own `draft → needs-confirmation/published` writes none either — the audit
 * log is the money ledger the rule-auditor reads (ADR-0003 is about money and
 * Order state), and catalog lifecycle is not in its vocabulary. Provenance
 * lives instead in `products.extraction`: the `ConfirmationStamp` is written
 * in the same transaction as the publish, so "what the model said" and "what
 * the merchant answered" stay side by side on the row.
 */

// ---------------------------------------------------------------------------
// Views — what the confirmation screen reads.
// ---------------------------------------------------------------------------

export interface ConfirmationVariantView {
  readonly variantId: string;
  readonly label: string | null;
  readonly isDefault: boolean;
  /** Null = honestly unknown (T12): the caption never stated it. */
  readonly pricePaise: number | null;
  readonly stock: number | null;
}

export interface ConfirmationProductView {
  readonly productId: string;
  readonly title: string;
  readonly description: string | null;
  readonly status: ProductStatus;
  /** Per-field values, confidences and hold reasons. Null for hand-seeded rows. */
  readonly extraction: ProductExtractionRecord | null;
  readonly variants: readonly ConfirmationVariantView[];
}

/** Every Product waiting on the merchant, oldest first — the screen's worklist. */
export async function listProductsNeedingConfirmation(
  executor: Executor,
  merchantId: string,
): Promise<ConfirmationProductView[]> {
  const rows = await executor
    .select()
    .from(products)
    .where(and(eq(products.merchantId, merchantId), eq(products.status, 'needs_confirmation')))
    .orderBy(asc(products.createdAt), asc(products.id));
  if (rows.length === 0) return [];

  const variantRows = await executor
    .select()
    .from(variants)
    .where(
      inArray(
        variants.productId,
        rows.map((row) => row.id),
      ),
    )
    .orderBy(asc(variants.label), asc(variants.id));

  const byProduct = new Map<string, ConfirmationVariantView[]>();
  for (const variant of variantRows) {
    const list = byProduct.get(variant.productId) ?? [];
    list.push(toVariantView(variant));
    byProduct.set(variant.productId, list);
  }

  return rows.map((row) => toProductView(row, byProduct.get(row.id) ?? []));
}

/** One Product in any status — after confirming, the screen re-reads this and sees `published`. */
export async function findConfirmationProduct(
  executor: Executor,
  merchantId: string,
  productId: string,
): Promise<ConfirmationProductView | null> {
  const [row] = await executor
    .select()
    .from(products)
    .where(and(eq(products.id, productId), eq(products.merchantId, merchantId)))
    .limit(1);
  if (row === undefined) return null;

  const variantRows = await executor
    .select()
    .from(variants)
    .where(eq(variants.productId, productId))
    .orderBy(asc(variants.label), asc(variants.id));

  return toProductView(row, variantRows.map(toVariantView));
}

function toVariantView(row: typeof variants.$inferSelect): ConfirmationVariantView {
  return {
    variantId: row.id,
    label: row.label,
    isDefault: row.isDefault,
    pricePaise: row.pricePaise,
    stock: row.stock,
  };
}

function toProductView(
  row: typeof products.$inferSelect,
  variantViews: readonly ConfirmationVariantView[],
): ConfirmationProductView {
  return {
    productId: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    extraction: row.extraction,
    variants: variantViews,
  };
}

// ---------------------------------------------------------------------------
// The submission — the complete final state the merchant vouches for.
// ---------------------------------------------------------------------------

export interface ConfirmationVariantSubmission {
  /** An existing Variant row to keep (corrected); omit to create a new one. */
  readonly variantId?: string | undefined;
  /** Null only for the single implicit default Variant (CONTEXT.md → Variant). */
  readonly label: string | null;
  /** Integer paise, positive — the number checkout will trust. */
  readonly pricePaise: number;
  /** A stated count, ≥ 0 — 0 means "sold out", a fact; unknown cannot publish. */
  readonly stock: number;
}

export interface ConfirmationSubmission {
  readonly title: string;
  readonly description: string | null;
  readonly variants: readonly ConfirmationVariantSubmission[];
}

interface NormalizedVariant {
  readonly variantId: string | null;
  readonly label: string | null;
  readonly isDefault: boolean;
  readonly pricePaise: number;
  readonly stock: number;
}

export interface NormalizedSubmission {
  readonly title: string;
  readonly description: string | null;
  readonly variants: readonly NormalizedVariant[];
}

function invalid(message: string): ValidationError {
  return new ValidationError('INVALID_CONFIRMATION', message);
}

/**
 * Pure validation and normalisation — every rule that decides whether a
 * submission *can* publish, with no database in sight (testable exactly like
 * `pipeline.ts`'s gating rules). Existing-row checks (unknown variantId,
 * product status) stay in `confirmProduct`, which can see the rows.
 */
export function normalizeSubmission(raw: ConfirmationSubmission): NormalizedSubmission {
  const title = raw.title.trim();
  if (title === '') throw invalid('title must not be empty');

  const description = raw.description === null ? null : raw.description.trim();

  if (raw.variants.length === 0) {
    throw invalid('a Product publishes with at least one Variant — none were submitted');
  }

  const seenLabels = new Set<string>();
  const seenIds = new Set<string>();
  const normalized = raw.variants.map((variant): NormalizedVariant => {
    if (!Number.isSafeInteger(variant.pricePaise) || variant.pricePaise <= 0) {
      throw invalid(
        `price must be a positive integer number of paise, got ${String(variant.pricePaise)}` +
          ' (CONTEXT.md → Money: 129900 means ₹1,299.00)',
      );
    }
    if (!Number.isSafeInteger(variant.stock) || variant.stock < 0) {
      throw invalid(
        `stock must be a stated count — an integer ≥ 0 — got ${String(variant.stock)}; ` +
          'a Product never publishes with unknown or invented stock',
      );
    }

    const label = variant.label === null ? null : variant.label.trim();
    if (label === '') {
      throw invalid('a variant label must not be blank — use null for the single default Variant');
    }
    if (label === null && raw.variants.length > 1) {
      throw invalid(
        'a null label means the single implicit default Variant; a Product with several ' +
          'Variants must label each one',
      );
    }
    if (label !== null) {
      // Same key the pipeline matches stated stock counts with (`stockKey` in
      // pipeline.ts): "UK 10" and "uk10" are one label, and two rows sharing
      // it would make one of them unreachable.
      const key = normalizeName(label).replaceAll(' ', '');
      if (seenLabels.has(key)) throw invalid(`duplicate variant label: ${label}`);
      seenLabels.add(key);
    }

    const variantId = variant.variantId ?? null;
    if (variantId !== null) {
      if (seenIds.has(variantId)) throw invalid(`variantId submitted twice: ${variantId}`);
      seenIds.add(variantId);
    }

    return {
      variantId,
      label,
      isDefault: label === null,
      pricePaise: variant.pricePaise,
      stock: variant.stock,
    };
  });

  return {
    title,
    description: description === '' ? null : description,
    variants: normalized,
  };
}

export interface ConfirmedProduct {
  readonly productId: string;
  readonly status: 'published';
  readonly product: ConfirmationProductView;
}

/**
 * The merchant's answer, applied: correct the Product's fields, make the
 * Variant set exactly what was submitted, stamp the extraction record, and flip
 * `needs-confirmation → published` — one transaction, so a Product is never
 * half-corrected or published with rows it was not confirmed with.
 *
 * Variant reshaping is allowed here and only here: a held Product was never
 * `published`, so no Cart mandate, order line, or oversell check can reference
 * its Variants yet — deleting a mis-extracted row (the "one size fits all" /
 * "beige" phantom-variants case from the S3 spike) is correcting fiction, not
 * rewriting history. Submitted rows with a `variantId` update in place; rows
 * without one are inserted; existing rows not in the submission are deleted.
 *
 * The publish itself is the house exactly-once pattern: the status guard lives
 * in the UPDATE's WHERE clause, so two concurrent confirmations cannot both
 * win — the loser's transaction rolls back its variant writes and reports
 * PRODUCT_NOT_CONFIRMABLE.
 */
export async function confirmProduct(
  db: Database,
  merchantId: string,
  productId: string,
  raw: ConfirmationSubmission,
  now: () => Date = () => new Date(),
): Promise<ConfirmedProduct> {
  const submission = normalizeSubmission(raw);

  await db.transaction(async (tx) => {
    const [product] = await tx
      .select()
      .from(products)
      .where(and(eq(products.id, productId), eq(products.merchantId, merchantId)))
      .limit(1);
    if (product === undefined) {
      throw new ValidationError('PRODUCT_NOT_FOUND', `no product ${productId} for this merchant`);
    }
    if (product.status !== 'needs_confirmation') {
      throw new ValidationError(
        'PRODUCT_NOT_CONFIRMABLE',
        `product ${productId} is '${product.status}' — only a needs-confirmation Product is confirmable`,
      );
    }

    const existing = await tx.select().from(variants).where(eq(variants.productId, productId));
    const existingIds = new Set(existing.map((row) => row.id));
    for (const variant of submission.variants) {
      if (variant.variantId !== null && !existingIds.has(variant.variantId)) {
        throw invalid(`variantId ${variant.variantId} does not belong to product ${productId}`);
      }
    }

    // Rows the merchant dropped (mis-extracted labels). Safe by construction:
    // the Product was never published, so nothing money-side references them.
    const keptIds = new Set(
      submission.variants.flatMap((v) => (v.variantId === null ? [] : [v.variantId])),
    );
    const dropIds = existing.filter((row) => !keptIds.has(row.id)).map((row) => row.id);
    if (dropIds.length > 0) {
      await tx.delete(variants).where(inArray(variants.id, dropIds));
    }

    for (const variant of submission.variants) {
      const values = {
        label: variant.label,
        isDefault: variant.isDefault,
        pricePaise: variant.pricePaise,
        stock: variant.stock,
      };
      if (variant.variantId === null) {
        await tx.insert(variants).values({ id: newId('variant'), productId, ...values });
      } else {
        await tx.update(variants).set(values).where(eq(variants.id, variant.variantId));
      }
    }

    const stamp: ConfirmationStamp = {
      confirmedAt: now().toISOString(),
      submitted: {
        title: submission.title,
        description: submission.description,
        variants: submission.variants.map((v) => ({
          label: v.label,
          pricePaise: v.pricePaise,
          stock: v.stock,
        })),
      },
    };

    const published = await tx
      .update(products)
      .set({
        title: submission.title,
        description: submission.description,
        status: 'published',
        ...(product.extraction === null
          ? {}
          : { extraction: { ...product.extraction, confirmation: stamp } }),
      })
      // The exactly-once guard: state in the WHERE clause, never read-then-write.
      .where(and(eq(products.id, productId), eq(products.status, 'needs_confirmation')))
      .returning({ id: products.id });
    if (published.length === 0) {
      throw new ValidationError(
        'PRODUCT_NOT_CONFIRMABLE',
        `product ${productId} was confirmed concurrently — nothing left to confirm`,
      );
    }
  });

  const product = await findConfirmationProduct(db, merchantId, productId);
  if (product === null || product.status !== 'published') {
    // Unreachable by construction; refusing loudly beats returning a lie.
    throw new Error(`product ${productId} did not read back as published after confirmation`);
  }
  return { productId, status: 'published', product };
}
