import { randomUUID } from 'node:crypto';
import type { Database } from '../db/client.js';
import { newId } from '../domain/ids.js';
import { ValidationError } from '../domain/refusal.js';
import { fetchImage } from './fetchImage.js';
import { type IngestIds, type IngestedProduct, ingestItem } from './ingest.js';
import { normalizeName } from './matchers.js';
import type { ExtractionImage, ExtractionModel } from './types.js';

/**
 * The WS1 seam (S1.3): a Merchant adds a Product from chat.
 *
 * The one thing this module exists to guarantee is that the chat connector is
 * a **front door and nothing else**. What crosses the gap is the caption
 * verbatim and at most one photo; extraction runs here, server-side, through
 * exactly the `ingestItem` the dataset path runs — same prompt, same 0.90
 * confidence gate, same "a field the caption did not state becomes a hold". A
 * client that extracted fields itself and posted them would be inventing
 * stock in the one column the oversell check trusts, so there is no argument
 * shaped like that anywhere in `CatalogSubmission`.
 *
 * Two things differ from the dataset path, both of them id policy:
 *   - ids are random (`prd_…`/`var_…`), never the dataset's `prd_demo_…`;
 *   - the source id is namespaced `sub_`, so a submission can never collide
 *     with a dataset item and `ingest:demo` keeps behaving exactly as it did.
 *
 * No idempotency in v1, deliberately: two submissions of the same caption make
 * two Products. A merchant who sends the same drop twice meant it, and the
 * repair for a mis-send is `catalog:archive` (plan D3), not a silent merge.
 * Keying on the client's `sourceId` is a logged follow-up (plan §10).
 */

export interface CatalogSubmission {
  /**
   * The merchant's caption **verbatim** — Hinglish, emoji and line breaks
   * intact, or the verbatim visible text of a screenshot. Never a description
   * of the photo written by the client: the pipeline is reading what the
   * merchant wrote, and a paraphrase is a different document.
   */
  readonly caption: string;
  /** A public http(s) photo link. Fetched here under the plan D4 guard. */
  readonly imageUrl?: string | undefined;
  /** The photo's bytes, when the client already has them. Needs `imageMediaType`. */
  readonly imageBase64?: string | undefined;
  readonly imageMediaType?: string | undefined;
  /** The merchant's own name for this drop; only ever a *suffix* of the source id. */
  readonly sourceId?: string | undefined;
}

export interface SubmitCatalogItemOptions {
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
}

/** Random ids: every submission is a new Product, by decision (see above). */
export const SUBMISSION_INGEST_IDS: IngestIds = {
  productId: () => newId('product'),
  variantId: () => newId('variant'),
};

function invalid(message: string): ValidationError {
  return new ValidationError('INVALID_SUBMISSION', message);
}

function slug(raw: string): string {
  return normalizeName(raw).replaceAll(' ', '_').slice(0, 40);
}

/**
 * `sub_` + the merchant's own label when they gave a usable one, else a uuid.
 * The prefix is the whole point: `productIdForSource` is not in play here, but
 * the source id lands in the extraction record and in `list_held_products`,
 * and "did this come from chat or from the dataset?" must be answerable from
 * the row alone.
 */
export function submissionSourceId(clientSourceId?: string | undefined): string {
  const named = slug(clientSourceId ?? '');
  return `sub_${named === '' ? randomUUID().replaceAll('-', '') : named}`;
}

export async function submitCatalogItem(
  db: Database,
  merchantId: string,
  model: ExtractionModel,
  submission: CatalogSubmission,
  options: SubmitCatalogItemOptions = {},
): Promise<IngestedProduct> {
  const caption = submission.caption.trim();
  if (caption === '') {
    throw invalid('caption is required — send the merchant\'s caption verbatim');
  }

  const hasUrl = (submission.imageUrl ?? '').trim() !== '';
  const hasBytes = (submission.imageBase64 ?? '').trim() !== '';
  if (hasUrl && hasBytes) {
    // Which photo did the merchant mean? Guessing would put the wrong picture
    // in front of the model, so this is a question, not a default.
    throw invalid('send either imageUrl or imageBase64, never both');
  }

  let image: ExtractionImage | null = null;
  if (hasUrl) {
    image = await fetchImage(submission.imageUrl as string, {
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    });
  } else if (hasBytes) {
    const mediaType = (submission.imageMediaType ?? '').trim().toLowerCase();
    if (!mediaType.startsWith('image/')) {
      throw invalid('imageBase64 needs an imageMediaType like image/jpeg');
    }
    image = { mediaType, base64: (submission.imageBase64 as string).trim() };
  }

  return ingestItem(
    db,
    merchantId,
    model,
    {
      sourceId: submissionSourceId(submission.sourceId),
      caption,
      // Deliberately null: `imagePath` is a repo-relative file the T13 viewer
      // opens, and a remote URL there would 404 it. Storing the submitted URL
      // on the extraction record is a follow-up (plan §10).
      imagePath: null,
      image,
    },
    {
      ids: SUBMISSION_INGEST_IDS,
      ...(options.now === undefined ? {} : { now: options.now }),
    },
  );
}
