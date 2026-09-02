import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEMO_DATASET_DIR } from './demoDataset.js';
import {
  type RunRecord,
  compareRow,
  formatCompareTable,
  runRecordFileName,
} from './runRecord.js';

const committed = JSON.parse(
  readFileSync(resolve(DEMO_DATASET_DIR, 'runs', 'gpt-5-mini.json'), 'utf8'),
) as RunRecord;

describe('runRecordFileName', () => {
  it('keeps the bare model name for openai — the record CI pins', () => {
    expect(
      runRecordFileName({ provider: 'openai', model: 'gpt-5-mini', outputMode: 'json_schema' }),
    ).toBe('gpt-5-mini.json');
  });

  it('prefixes the provider and slugs the model id for everything else', () => {
    expect(
      runRecordFileName({
        provider: 'openrouter',
        model: 'z-ai/glm-5.3-flash',
        outputMode: 'tool_call',
      }),
    ).toBe('openrouter-z-ai-glm-5-3-flash-tool-call.json');
  });

  it('slugs the `:free` suffix rather than leaving a colon in a filename', () => {
    expect(
      runRecordFileName({
        provider: 'openrouter',
        model: 'minimax/minimax-m3:free',
        outputMode: 'json_schema',
      }),
    ).toBe('openrouter-minimax-minimax-m3-free-json-schema.json');
  });

  it('separates the two output modes of one model — they are two measurements', () => {
    const glm = { provider: 'openrouter', model: 'z-ai/glm-5.3-flash' } as const;
    expect(runRecordFileName({ ...glm, outputMode: 'json_schema' })).not.toBe(
      runRecordFileName({ ...glm, outputMode: 'tool_call' }),
    );
  });
});

describe('compareRow', () => {
  it('reads the committed OpenAI record, defaulting the fields it predates', () => {
    const row = compareRow(committed);
    expect(row.model).toBe('gpt-5-mini');
    // The record was written before S2.3 added these two keys.
    expect(row.provider).toBe('openai');
    expect(row.outputMode).toBe('json_schema');
    expect(row.published).toBe(3);
    expect(row.needsConfirmation).toBe(25);
    expect(row.publishedWithWrongField).toBe(0);
    expect(row.wrongFields).toBe(1);
    expect(row.elapsedSeconds).toBe(169);
    expect(row.perField['price']).toBe(1);
    expect(row.perField['name']).toBeCloseTo(27 / 28, 5);
  });

  it('reports what the record itself says once provider and mode are recorded', () => {
    const row = compareRow({
      ...committed,
      model: 'z-ai/glm-5.3-flash',
      provider: 'openrouter',
      outputMode: 'tool_call',
    });
    expect(row.provider).toBe('openrouter');
    expect(row.outputMode).toBe('tool_call');
  });
});

describe('formatCompareTable', () => {
  const table = formatCompareTable([
    compareRow(committed),
    compareRow({
      ...committed,
      model: 'z-ai/glm-5.3-flash',
      provider: 'openrouter',
      outputMode: 'tool_call',
    }),
  ]);

  it('has a column per reportable field plus the lifecycle and cost columns', () => {
    const header = table.split('\n')[0] ?? '';
    for (const column of [
      'model',
      'mode',
      'name',
      'price',
      'stock',
      'variantLabels',
      'descriptionPresence',
      'pub/held',
      'wrongPublished',
      'elapsed',
    ]) {
      expect(header).toContain(column);
    }
  });

  it('renders one row per record, named by provider and model', () => {
    expect(table).toContain('gpt-5-mini');
    expect(table).toContain('z-ai/glm-5.3-flash');
    expect(table).toContain('3/25');
  });
});
