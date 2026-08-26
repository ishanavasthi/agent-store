import type { Database } from '../db/client.js';
import { products, variants } from '../db/schema.js';
import type { HoldReason } from './extractionRecord.js';
import { normalizeName } from './matchers.js';
import { type AssembledProduct, type SourceItem, assembleProduct } from './pipeline.js';
import type { ExtractionImage, ExtractionModel } from './types.js';

/**
 * Ingestion end to end: caption+photo → extraction (through the swappable
 * `ExtractionModel` seam) → assembled Product (pure `pipeline.ts` rules) →
 * rows. This module owns only the seams' wiring and the persistence, so the
 * whole thing runs identically under the canned test extractor and the real
 * OpenAI model — which model is `EXTRACTION_MODEL` configuration, as always.
 *
 * Ids are deterministic functions of the dataset item id (`prd_demo_…`,
 * `var_demo_…`), and an existing Product is **skipped, never overwritten**:
 * after T13's confirmation screen has corrected a held Product, a re-run of
 * `ingest:demo` must not silently undo the merchant's answers. Re-ingesting
 * from scratch means dropping the rows first, deliberately.
 */

export interface IngestItem extends SourceItem {
  readonly image: ExtractionImage | null;
}

export interface IngestOptions {
  /** Auto-publish threshold override; defaults to `AUTO_PUBLISH_THRESHOLD`. */
  readonly threshold?: number;
  readonly now?: () => Date;
}

export interface IngestedProduct {
  readonly productId: string;
  readonly sourceId: string;
  readonly status: AssembledProduct['status'];
  readonly holds: readonly HoldReason[];
  /** False when the Product already existed and the row was left untouched. */
  readonly created: boolean;
  readonly title: string;
}

export function productIdForSource(sourceId: string): string {
  return `prd_demo_${slug(sourceId)}`;
}

export function variantIdForSource(sourceId: string, label: string | null): string {
  return `var_demo_${slug(sourceId)}_${label === null ? 'default' : slug(label)}`;
}

function slug(raw: string): string {
  return normalizeName(raw).replaceAll(' ', '_');
}

export async function ingestItem(
  db: Database,
  merchantId: string,
  model: ExtractionModel,
  item: IngestItem,
  options: IngestOptions = {},
): Promise<IngestedProduct> {
  const result = await model.extract({ caption: item.caption, image: item.image });
  const assembled = assembleProduct(
    { sourceId: item.sourceId, caption: item.caption, imagePath: item.imagePath },
    result.extraction,
    {
      modelId: result.modelId,
      extractedAt: (options.now ?? (() => new Date()))(),
      ...(options.threshold === undefined ? {} : { threshold: options.threshold }),
    },
  );
  return persistAssembledProduct(db, merchantId, assembled);
}

export async function ingestItems(
  db: Database,
  merchantId: string,
  model: ExtractionModel,
  items: readonly IngestItem[],
  options: IngestOptions = {},
  onProduct?: (product: IngestedProduct) => void,
): Promise<IngestedProduct[]> {
  // Sequential like the spike runner: ~30 items are minutes either way, and a
  // serial run keeps output readable and rate limits out of the picture.
  const out: IngestedProduct[] = [];
  for (const item of items) {
    const product = await ingestItem(db, merchantId, model, item, options);
    out.push(product);
    onProduct?.(product);
  }
  return out;
}

/**
 * Product + Variants + extraction record, one transaction — an assembled
 * Product either lands whole or not at all.
 */
export async function persistAssembledProduct(
  db: Database,
  merchantId: string,
  assembled: AssembledProduct,
): Promise<IngestedProduct> {
  const productId = productIdForSource(assembled.sourceId);

  const created = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(products)
      .values({
        id: productId,
        merchantId,
        title: assembled.title,
        description: assembled.description,
        status: assembled.status,
        extraction: assembled.record,
      })
      .onConflictDoNothing()
      .returning({ id: products.id });
    if (inserted.length === 0) return false;

    await tx.insert(variants).values(
      assembled.variants.map((variant) => ({
        id: variantIdForSource(assembled.sourceId, variant.label),
        productId,
        label: variant.label,
        isDefault: variant.isDefault,
        pricePaise: variant.pricePaise,
        stock: variant.stock,
      })),
    );
    return true;
  });

  return {
    productId,
    sourceId: assembled.sourceId,
    status: assembled.status,
    holds: assembled.record.holds,
    created,
    title: assembled.title,
  };
}
