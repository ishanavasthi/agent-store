import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type DemoItemScore, type DemoSummary, scoreDemoItem, summarizeDemo } from '../accuracy.js';
import { DEMO_DATASET_DIR, loadDemoDataset } from '../demoDataset.js';
import { DEFAULT_EXTRACTION_MODEL } from '../extractionModel.js';
import { ExtractionError } from '../types.js';
import { parsePayload, toExtraction } from './toExtraction.js';

/**
 * The payload boundary, against the only 28 real payloads this project has.
 *
 * `fixtures/demo-dataset/runs/gpt-5-mini.json` is input here, never output: the
 * run recorded both the raw payload and the score it produced, so re-parsing
 * every raw through the new zod path and re-scoring it must land on the score
 * already committed. That is the whole safety argument for the split — the
 * numbers the repo quotes are unchanged because the code that produces them is.
 */

interface RunRecord {
  readonly summary: DemoSummary;
  readonly records: readonly { readonly id: string; readonly score: DemoItemScore; readonly raw: string }[];
}

const run = JSON.parse(
  readFileSync(resolve(DEMO_DATASET_DIR, 'runs', `${DEFAULT_EXTRACTION_MODEL}.json`), 'utf8'),
) as RunRecord;

const dataset = await loadDemoDataset();

/** A payload known good, so each rejection test changes exactly one thing. */
function validPayload(): Record<string, unknown> {
  return {
    name: { value: 'ZORA Cargo Pants', confidence: 0.9 },
    description: { value: 'Six-pocket cotton cargos.', confidence: 0.85 },
    priceText: { value: '₹1,299/-', confidence: 0.95 },
    stock: { value: 12, confidence: 0.9 },
    variantLabels: { value: ['30', '32'], confidence: 0.9 },
    variantStock: { value: [{ label: '32', count: 3 }], confidence: 0.8 },
  };
}

describe('parsePayload over the committed gpt-5-mini run', () => {
  it('validates all 28 recorded raw payloads', () => {
    expect(run.records).toHaveLength(28);
    for (const record of run.records) {
      expect(() => parsePayload(record.raw), record.id).not.toThrow();
    }
  });

  it('re-scores every item to the score committed with the run', () => {
    const scores = run.records.map((record) => {
      const item = dataset.items.find((candidate) => candidate.id === record.id);
      expect(item, `dataset item ${record.id}`).toBeDefined();
      return scoreDemoItem(record.id, item!.label, toExtraction(parsePayload(record.raw)));
    });

    for (const [index, score] of scores.entries()) {
      expect(score, score.id).toEqual(run.records[index]!.score);
    }
    expect(summarizeDemo(scores)).toEqual(run.summary);
  });
});

describe('parsePayload rejects a payload that drifted', () => {
  const cases: readonly { readonly label: string; readonly path: string; readonly mutate: (p: Record<string, unknown>) => void }[] = [
    {
      label: 'map-shaped variantStock',
      path: 'variantStock.value',
      // The shape a model reaches for when it ignores the schema.
      mutate: (p) => {
        p['variantStock'] = { value: { '32': 3 }, confidence: 0.8 };
      },
    },
    {
      label: 'a stock count as a string',
      path: 'stock.value',
      mutate: (p) => {
        p['stock'] = { value: '12', confidence: 0.9 };
      },
    },
    {
      label: 'a missing key',
      path: 'priceText',
      mutate: (p) => {
        delete p['priceText'];
      },
    },
    {
      label: 'an extra key',
      path: 'colour',
      mutate: (p) => {
        p['colour'] = { value: 'lilac', confidence: 0.5 };
      },
    },
  ];

  for (const { label, path, mutate } of cases) {
    it(`refuses ${label}, naming the path and quoting the payload`, () => {
      const payload = validPayload();
      mutate(payload);
      const rawText = JSON.stringify(payload);

      expect(() => parsePayload(rawText)).toThrow(ExtractionError);
      try {
        parsePayload(rawText);
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toContain(`\`${path}\``);
        expect(message).toContain(rawText.slice(0, 60));
      }
    });
  }

  it('refuses text that is not JSON at all, quoting what it got', () => {
    expect(() => parsePayload('Sorry, I cannot help with that.')).toThrow(
      /Could not parse extraction payload as JSON: Sorry, I cannot help/,
    );
  });

  it('quotes at most 300 characters of the raw text', () => {
    const rawText = JSON.stringify({ ...validPayload(), padding: 'x'.repeat(1000) });
    try {
      parsePayload(rawText);
      expect.unreachable('a payload with an extra key must not parse');
    } catch (error) {
      expect((error as Error).message).toContain(rawText.slice(0, 300));
      expect((error as Error).message).not.toContain(rawText.slice(0, 301));
    }
  });
});

describe('toExtraction keeps the domain rules the run was scored under', () => {
  it('clamps a confidence the model overstated, and zeroes a null value', () => {
    const extraction = toExtraction(
      parsePayload(
        JSON.stringify({
          ...validPayload(),
          name: { value: 'ZORA Cargo Pants', confidence: 4 },
          description: { value: null, confidence: 0.9 },
        }),
      ),
    );
    expect(extraction.name.confidence).toBe(1);
    expect(extraction.description).toEqual({ value: null, confidence: 0 });
  });

  it('leaves the price null but keeps priceText when the caption is unparseable', () => {
    // "MRP 2,999 sirf ₹1,899/-" is two amounts: `parseRupeePrice` refuses it.
    const extraction = toExtraction(
      parsePayload(
        JSON.stringify({
          ...validPayload(),
          priceText: { value: 'MRP 2,999 sirf ₹1,899/-', confidence: 0.9 },
        }),
      ),
    );
    expect(extraction.price).toEqual({ value: null, confidence: 0 });
    expect(extraction.priceText).toEqual({ value: 'MRP 2,999 sirf ₹1,899/-', confidence: 0.9 });
  });

  it('never invents stock the payload did not state', () => {
    const extraction = toExtraction(
      parsePayload(JSON.stringify({ ...validPayload(), stock: { value: null, confidence: 0.9 } })),
    );
    expect(extraction.stock).toEqual({ value: null, confidence: 0 });
  });

  it('folds variant pairs into a record, dropping blank labels and negative counts', () => {
    const extraction = toExtraction(
      parsePayload(
        JSON.stringify({
          ...validPayload(),
          variantStock: {
            value: [
              { label: '32', count: 3 },
              { label: '   ', count: 5 },
              { label: '30', count: -1 },
            ],
            confidence: 0.8,
          },
        }),
      ),
    );
    expect(extraction.variantStock.value).toEqual({ '32': 3 });
  });
});
