import type { FieldAccuracy, ScoredField, SweepPoint } from './accuracy.js';
import type { ExtractionOutputMode, ExtractionProvider } from './extraction/config.js';

/**
 * The committed accuracy record: how it is named, and how many of them are
 * read back into one table (plan §5, S2.3).
 *
 * Naming is the load-bearing part. `demoRun.test.ts` pins
 * `runs/<DEFAULT_EXTRACTION_MODEL>.json` by name, so the OpenAI record keeps
 * the bare model name it has always had; every other provider writes
 * `runs/<provider>-<slug(model)>-<slug(outputMode)>.json`, because an
 * OpenRouter model id (`z-ai/glm-5.3-flash`, `minimax/minimax-m3:free`)
 * contains characters a filename cannot carry, two providers may serve the
 * same model name, and the same model in the two output modes is two
 * different measurements that must not overwrite each other — S2.3 asks for
 * four records over two models, and the plan's `<provider>-<model>.json`
 * would have produced two (DECISIONS.md, 2026-09-03).
 *
 * The pure half of `runAccuracy.ts` / `runCompare.ts` lives here so it can be
 * tested: those two modules run their work on import, as every script in this
 * repo does, and a test that imported one would make live billed calls.
 */

/** The shape `runAccuracy.ts` writes. Kept structural: records predate S2.3. */
export interface RunRecord {
  readonly model: string;
  /** Absent in records written before S2.3, when only OpenAI existed. */
  readonly provider?: ExtractionProvider;
  /** Absent likewise; the OpenAI path has always been `json_schema`. */
  readonly outputMode?: ExtractionOutputMode;
  readonly ranAt: string;
  readonly elapsedSeconds: number;
  readonly accuracyFloor: number;
  readonly allFloorsMet: boolean;
  readonly autoPublishThreshold: number;
  readonly dataset: { readonly merchant: string; readonly items: number };
  readonly summary: {
    readonly items: number;
    readonly perField: readonly FieldAccuracy[];
    readonly variantStock: FieldAccuracy;
  };
  readonly lifecycle: {
    readonly published: number;
    readonly needsConfirmation: number;
    readonly publishedIds: readonly string[];
    readonly publishedWithWrongField: readonly { readonly id: string }[];
  };
  readonly wrongFields: readonly unknown[];
  readonly sweep: readonly SweepPoint[];
  readonly records: readonly unknown[];
}

/**
 * A model id as a filename fragment: lowercase, every run of characters a
 * path should not carry collapsed to a single dash.
 */
export function slugModelId(model: string): string {
  return model
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function runRecordFileName(config: {
  readonly provider: ExtractionProvider;
  readonly model: string;
  readonly outputMode: ExtractionOutputMode;
}): string {
  return config.provider === 'openai'
    ? `${config.model}.json`
    : `${config.provider}-${slugModelId(config.model)}-${slugModelId(config.outputMode)}.json`;
}

/** One line of the comparison table, derived from one committed record. */
export interface CompareRow {
  readonly model: string;
  readonly provider: ExtractionProvider;
  readonly outputMode: ExtractionOutputMode;
  /** Accuracy 0–1 by reportable field name, plus `variantStock`. */
  readonly perField: Readonly<Partial<Record<ScoredField, number>>>;
  readonly published: number;
  readonly needsConfirmation: number;
  /** The number that disqualifies a model outright when it is not zero. */
  readonly publishedWithWrongField: number;
  readonly wrongFields: number;
  readonly elapsedSeconds: number;
}

export function compareRow(record: RunRecord): CompareRow {
  const perField: Partial<Record<ScoredField, number>> = {};
  for (const field of record.summary.perField) perField[field.field] = field.accuracy;
  perField[record.summary.variantStock.field] = record.summary.variantStock.accuracy;

  return {
    model: record.model,
    // Records written before S2.3 carry neither key, and every one of them is
    // an OpenAI Responses run with provider-enforced Structured Outputs.
    provider: record.provider ?? 'openai',
    outputMode: record.outputMode ?? 'json_schema',
    perField,
    published: record.lifecycle.published,
    needsConfirmation: record.lifecycle.needsConfirmation,
    publishedWithWrongField: record.lifecycle.publishedWithWrongField.length,
    wrongFields: record.wrongFields.length,
    elapsedSeconds: record.elapsedSeconds,
  };
}

const COLUMN_FIELDS: readonly ScoredField[] = [
  'name',
  'price',
  'stock',
  'variantLabels',
  'descriptionPresence',
  'variantStock',
];

const pct = (n: number | undefined): string =>
  n === undefined ? '—' : `${(n * 100).toFixed(0)}%`;

/** A fixed-width table, so a terminal and a pasted README block read alike. */
export function formatCompareTable(rows: readonly CompareRow[]): string {
  const header = [
    'model',
    'provider',
    'mode',
    ...COLUMN_FIELDS,
    'pub/held',
    'wrongPublished',
    'elapsed',
  ];
  const body = rows.map((row) => [
    row.model,
    row.provider,
    row.outputMode,
    ...COLUMN_FIELDS.map((field) => pct(row.perField[field])),
    `${String(row.published)}/${String(row.needsConfirmation)}`,
    String(row.publishedWithWrongField),
    `${String(row.elapsedSeconds)}s`,
  ]);

  const widths = header.map((cell, column) =>
    Math.max(cell.length, ...body.map((line) => (line[column] ?? '').length)),
  );
  const line = (cells: readonly string[]): string =>
    cells.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join('  ').trimEnd();

  return [line(header), line(widths.map((width) => '-'.repeat(width))), ...body.map(line)].join(
    '\n',
  );
}
