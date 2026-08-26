import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Paise, paise } from '../domain/money.js';
import type { ExtractionImage } from './types.js';

/**
 * The demo dataset boundary (T11's `fixtures/demo-dataset/`): 28 products,
 * captions plus hand labels. Shared by the accuracy script (which scores the
 * model against the labels) and the ingest script (which feeds the captions
 * and photos to the pipeline).
 *
 * Two rules enforced by the shape of this module:
 *   - **Labels never leak into extraction.** `DemoItem` keeps caption/image
 *     and label as separate properties; everything handed to the model is
 *     built from `caption` + `image` only, and nothing in the ingest path
 *     reads `label` at all. The labels are ground truth for scoring, not
 *     hints (fixtures README: the metrics must not be the project grading
 *     its own homework).
 *   - **Labels are untrusted input.** They are hand-typed JSON, and a rupee
 *     typo does not fail loudly — it silently scores every model as wrong.
 *     `parseDemoLabel` is where a bad label stops the run instead
 *     (same argument as the spike's `parseSpikeLabel`).
 */

export const DEMO_DATASET_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../fixtures/demo-dataset',
);

/** One hand label, after `parseDemoLabel` has vouched for it. */
export interface DemoLabel {
  readonly name: string;
  readonly pricePaise: Paise;
  /** Product-level stated count; null when the caption states none. */
  readonly stock: number | null;
  readonly variantLabels: readonly string[];
  /** Per-variant stated counts; `{}` when none. Never summed into `stock`. */
  readonly variantStock: Readonly<Record<string, number>>;
  readonly description: string;
}

export interface DemoItem {
  readonly id: string;
  /** Path relative to the dataset dir, e.g. `images/04-galli-cargo-pants.jpg`. */
  readonly image: string;
  readonly caption: string;
  readonly label: DemoLabel;
}

export interface DemoDataset {
  readonly merchant: string;
  readonly items: readonly DemoItem[];
}

interface RawLabel {
  readonly name: string;
  readonly pricePaise: number;
  readonly stock: number | null;
  readonly variantLabels: readonly string[];
  readonly variantStock: Readonly<Record<string, number>>;
  readonly description: string;
}

export function parseDemoLabel(id: string, raw: RawLabel): DemoLabel {
  const die = (what: string): never => {
    throw new Error(`Bad hand label for ${id}: ${what}`);
  };

  if (typeof raw.name !== 'string' || raw.name.trim() === '') die('name must be a non-empty string');
  if (typeof raw.description !== 'string' || raw.description.trim() === '')
    die('description must be a non-empty string');
  if (raw.stock !== null && !Number.isSafeInteger(raw.stock)) die('stock must be an integer or null');
  if (!Array.isArray(raw.variantLabels)) die('variantLabels must be an array');
  for (const [label, count] of Object.entries(raw.variantStock ?? die('variantStock missing'))) {
    if (!Number.isSafeInteger(count) || count < 0)
      die(`variantStock[${label}] must be a non-negative integer`);
  }

  return {
    name: raw.name,
    // The money boundary: a mistyped label price dies here, loudly.
    pricePaise: paise(raw.pricePaise),
    stock: raw.stock,
    variantLabels: raw.variantLabels,
    variantStock: raw.variantStock,
    description: raw.description,
  };
}

export async function loadDemoDataset(): Promise<DemoDataset> {
  const raw = await readFile(resolve(DEMO_DATASET_DIR, 'dataset.json'), 'utf8');
  const json = JSON.parse(raw) as {
    merchant: string;
    items: { id: string; image: string; caption: string; label: RawLabel }[];
  };
  return {
    merchant: json.merchant,
    items: json.items.map((item) => ({
      id: item.id,
      image: item.image,
      caption: item.caption,
      label: parseDemoLabel(item.id, item.label),
    })),
  };
}

export async function loadDemoImage(relativePath: string): Promise<ExtractionImage> {
  const bytes = await readFile(resolve(DEMO_DATASET_DIR, relativePath));
  return { mediaType: 'image/jpeg', base64: bytes.toString('base64') };
}
