import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEMO_DATASET_DIR } from '../demoDataset.js';
import { type ExtractionInput, ExtractionError } from '../types.js';
import { OpenAIExtractionModel } from './openaiResponsesModel.js';

/**
 * The OpenAI adapter with an injected `fetch`: the request shape and the
 * envelope walk, tested without spending a credit (the key is out of them —
 * plan §1). The request half is a golden comparison against bytes captured
 * from the pre-S2.1 adapter, so the split is provably shape-preserving.
 */

interface GoldenCase {
  readonly name: string;
  readonly input: ExtractionInput;
  readonly request: {
    readonly url: string;
    readonly method: string;
    readonly headers: Record<string, string>;
    readonly body: unknown;
  };
}

const golden = JSON.parse(
  readFileSync(
    resolve(DEMO_DATASET_DIR, '../extraction/openai-responses-request.golden.json'),
    'utf8',
  ),
) as { options: { model: string; apiKey: string }; cases: readonly GoldenCase[] };

const PAYLOAD = JSON.stringify({
  name: { value: 'ZORA Cargo Pants', confidence: 0.9 },
  description: { value: 'Six-pocket cotton cargos.', confidence: 0.85 },
  priceText: { value: '₹1,299/-', confidence: 0.95 },
  stock: { value: 12, confidence: 0.9 },
  variantLabels: { value: ['30', '32'], confidence: 0.9 },
  variantStock: { value: [], confidence: 0.8 },
});

/** A completed envelope whose `output` starts with a contentless reasoning item. */
function completedEnvelope(payload = PAYLOAD): unknown {
  return {
    model: 'gpt-5-mini-2025-08-07',
    status: 'completed',
    output: [
      { type: 'reasoning', id: 'rs_1', summary: [] },
      { type: 'message', content: [{ type: 'output_text', text: payload }] },
    ],
  };
}

/** Records what was sent and replies with whatever the test wants back. */
function stubFetch(reply: { status?: number; body: unknown }): {
  readonly fetchImpl: typeof fetch;
  readonly calls: { url: string; init: RequestInit }[];
} {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const text = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
    return new Response(text, { status: reply.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('the request the adapter sends', () => {
  for (const goldenCase of golden.cases) {
    it(`is byte-identical to the pre-refactor golden (${goldenCase.name})`, async () => {
      const { fetchImpl, calls } = stubFetch({ body: completedEnvelope() });
      const model = new OpenAIExtractionModel({ ...golden.options, fetchImpl });

      await model.extract(goldenCase.input);

      const call = calls[0];
      expect(call).toBeDefined();
      expect(call!.url).toBe(goldenCase.request.url);
      expect(call!.init.method).toBe(goldenCase.request.method);
      expect(call!.init.headers).toEqual(goldenCase.request.headers);
      // Byte equality, not deep equality: key order is part of the request.
      expect(call!.init.body).toBe(JSON.stringify(goldenCase.request.body));
    });
  }

  it('sends `reasoning.effort` only to the gpt-5 family', async () => {
    const captionOnly: ExtractionInput = { caption: 'Naya drop 🔥 ₹1,299/-', image: null };

    const gpt5 = stubFetch({ body: completedEnvelope() });
    await new OpenAIExtractionModel({
      model: 'gpt-5-mini',
      apiKey: 'sk-test',
      fetchImpl: gpt5.fetchImpl,
    }).extract(captionOnly);
    expect(JSON.parse(gpt5.calls[0]!.init.body as string)).toHaveProperty('reasoning.effort', 'low');

    const other = stubFetch({ body: completedEnvelope() });
    await new OpenAIExtractionModel({
      model: 'gpt-4.1-mini',
      apiKey: 'sk-test',
      fetchImpl: other.fetchImpl,
    }).extract(captionOnly);
    expect(JSON.parse(other.calls[0]!.init.body as string)).not.toHaveProperty('reasoning');
  });
});

describe('the envelope the adapter reads', () => {
  const input: ExtractionInput = { caption: 'ZORA cargos ₹1,299/- | 30, 32', image: null };
  const extract = (reply: { status?: number; body: unknown }) =>
    new OpenAIExtractionModel({
      model: 'gpt-5-mini',
      apiKey: 'sk-test',
      fetchImpl: stubFetch(reply).fetchImpl,
    }).extract(input);

  it('walks past a leading reasoning item to the message part', async () => {
    const result = await extract({ body: completedEnvelope() });
    expect(result.extraction.name.value).toBe('ZORA Cargo Pants');
    expect(result.rawResponse).toBe(PAYLOAD);
    // The dated snapshot the provider says served it, not the alias we asked for.
    expect(result.modelId).toBe('gpt-5-mini-2025-08-07');
  });

  it('turns a refusal part into an ExtractionError carrying the refusal', async () => {
    await expect(
      extract({
        body: {
          status: 'completed',
          output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'I cannot help.' }] }],
        },
      }),
    ).rejects.toThrow(/Model refused the extraction: I cannot help\./);
  });

  it('refuses an incomplete response rather than parsing a truncated payload', async () => {
    await expect(
      extract({
        body: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } },
      }),
    ).rejects.toThrow(/status was incomplete, not completed.*max_output_tokens/);
  });

  it('carries the provider body through a non-2xx', async () => {
    await expect(
      extract({ status: 429, body: { error: { message: 'Rate limit reached for gpt-5-mini' } } }),
    ).rejects.toThrow(/returned 429: .*Rate limit reached for gpt-5-mini/);
  });

  it('validates the payload even though the provider enforced the schema', async () => {
    // OpenRouter accepts `response_format` without enforcing it (plan §1); the
    // guarantee has to live here, so it is exercised on this path too.
    await expect(
      extract({ body: completedEnvelope(JSON.stringify({ name: 'ZORA Cargo Pants' })) }),
    ).rejects.toThrow(ExtractionError);
  });
});
