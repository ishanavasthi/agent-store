import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FieldAccuracy, SweepPoint } from './accuracy.js';
import { DEMO_DATASET_DIR } from './demoDataset.js';
import { DEFAULT_EXTRACTION_MODEL } from './extractionModel.js';
import { AUTO_PUBLISH_THRESHOLD } from './pipeline.js';

/**
 * The accuracy half of issue #13's test split, pinned to the real model
 * without touching the network: `npm run ingest:accuracy` makes the live
 * calls and commits the record at `fixtures/demo-dataset/runs/`; this suite
 * holds that committed record to the claims the repo makes about it. If a
 * re-run degrades below the floor, or the pinned default model changes out
 * from under the record, or the record stops backing `AUTO_PUBLISH_THRESHOLD`
 * — this fails, in CI, deterministically.
 */

interface RunRecord {
  readonly model: string;
  readonly accuracyFloor: number;
  readonly allFloorsMet: boolean;
  readonly autoPublishThreshold: number;
  readonly dataset: { readonly items: number };
  readonly summary: {
    readonly items: number;
    readonly perField: readonly FieldAccuracy[];
  };
  readonly lifecycle: {
    readonly published: number;
    readonly needsConfirmation: number;
    readonly publishedWithWrongField: readonly unknown[];
  };
  readonly sweep: readonly SweepPoint[];
  readonly records: readonly { readonly servedByModelId: string }[];
}

const run = JSON.parse(
  readFileSync(resolve(DEMO_DATASET_DIR, 'runs', `${DEFAULT_EXTRACTION_MODEL}.json`), 'utf8'),
) as RunRecord;

describe('the committed demo-dataset accuracy run', () => {
  it('is the pinned default model, over the full dataset', () => {
    expect(run.model).toBe(DEFAULT_EXTRACTION_MODEL);
    for (const record of run.records) {
      // Every item served by a dated snapshot of the pinned model, not a fallback.
      expect(record.servedByModelId.startsWith(DEFAULT_EXTRACTION_MODEL)).toBe(true);
    }
    expect(run.dataset.items).toBe(28);
    expect(run.summary.items).toBe(28);
  });

  it('meets the ~70% S3 floor on every reportable field', () => {
    expect(run.accuracyFloor).toBe(0.7);
    for (const field of run.summary.perField) {
      expect(field.accuracy, `${field.field} accuracy`).toBeGreaterThanOrEqual(run.accuracyFloor);
    }
    expect(run.allFloorsMet).toBe(true);
  });

  it('published nothing the hand labels say is wrong', () => {
    expect(run.lifecycle.publishedWithWrongField).toEqual([]);
    expect(run.lifecycle.published + run.lifecycle.needsConfirmation).toBe(28);
  });

  it('backs the chosen AUTO_PUBLISH_THRESHOLD: zero wrong fields clear it on this run', () => {
    expect(run.autoPublishThreshold).toBe(AUTO_PUBLISH_THRESHOLD);
    const point = run.sweep.find((p) => p.threshold === AUTO_PUBLISH_THRESHOLD);
    expect(point).toBeDefined();
    expect(point?.wrongAtOrAbove).toBe(0);
    // …and it is not vacuously safe by publishing nothing.
    expect(point?.correctAtOrAbove).toBeGreaterThan(0);
  });
});
