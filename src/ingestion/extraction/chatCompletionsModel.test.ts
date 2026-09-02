import { describe, expect, it } from 'vitest';
import { type ExtractionInput, ExtractionError } from '../types.js';
import { ChatCompletionsExtractionModel } from './chatCompletionsModel.js';
import { type ExtractionProviderConfig, readExtractionProviderConfig } from './config.js';
import { responseJsonSchema } from './payloadSchema.js';
import { INSTRUCTIONS } from './prompt.js';

/**
 * The OpenRouter adapter with an injected `fetch`: both request shapes, both
 * ways of reading the answer back, and the four failures that must be loud.
 *
 * No live call anywhere here — the demo's provider is proven by shape, and the
 * accuracy question belongs to the recorded runs in S2.3 (plan §5).
 */

const PAYLOAD = JSON.stringify({
  name: { value: 'ZORA Cargo Pants', confidence: 0.9 },
  description: { value: 'Six-pocket cotton cargos.', confidence: 0.85 },
  priceText: { value: '₹1,299/-', confidence: 0.95 },
  stock: { value: 12, confidence: 0.9 },
  variantLabels: { value: ['30', '32'], confidence: 0.9 },
  variantStock: { value: [{ label: '32', count: 3 }], confidence: 0.8 },
});

const CAPTION_ONLY: ExtractionInput = {
  caption: 'ZORA cargos ₹1,299/- | 30, 32',
  image: null,
};
const WITH_IMAGE: ExtractionInput = {
  caption: 'Naya drop 🔥',
  image: { mediaType: 'image/jpeg', base64: 'AQID' },
};

function config(env: Record<string, string> = {}): ExtractionProviderConfig {
  return readExtractionProviderConfig({
    EXTRACTION_PROVIDER: 'openrouter',
    OPENROUTER_API_KEY: 'or-key',
    EXTRACTION_MODEL: 'z-ai/glm-5.3-flash',
    ...env,
  });
}

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

/** A completed choice in whichever shape the output mode reads. */
function choiceEnvelope(
  mode: 'content' | 'tool_call',
  payload = PAYLOAD,
  extra: Record<string, unknown> = {},
): unknown {
  const message =
    mode === 'content'
      ? { role: 'assistant', content: payload, refusal: null }
      : {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'record_extraction', arguments: payload },
            },
          ],
        };
  return {
    model: 'z-ai/glm-5.3-flash',
    choices: [{ index: 0, finish_reason: 'stop', message, ...extra }],
  };
}

describe('the request the adapter sends', () => {
  it('is a system + user Chat Completions call with no reasoning parameter', async () => {
    const { fetchImpl, calls } = stubFetch({
      body: choiceEnvelope('tool_call'),
    });
    await new ChatCompletionsExtractionModel({
      config: config(),
      fetchImpl,
    }).extract(CAPTION_ONLY);

    expect(calls[0]!.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    const body = JSON.parse(calls[0]!.init.body as string) as Record<string, unknown>;
    expect(body['model']).toBe('z-ai/glm-5.3-flash');
    expect(body['max_tokens']).toBe(4000);
    // `reasoning` is a Responses-API parameter; a generic gateway 400s on it.
    expect(body).not.toHaveProperty('reasoning');
    expect(body['messages']).toEqual([
      { role: 'system', content: INSTRUCTIONS },
      {
        role: 'user',
        content: [{ type: 'text', text: `Caption:\n${CAPTION_ONLY.caption}` }],
      },
    ]);
  });

  it('sends the photo as an image_url part with a data URL', async () => {
    const { fetchImpl, calls } = stubFetch({
      body: choiceEnvelope('tool_call'),
    });
    await new ChatCompletionsExtractionModel({
      config: config(),
      fetchImpl,
    }).extract(WITH_IMAGE);

    const body = JSON.parse(calls[0]!.init.body as string) as {
      messages: { content: unknown }[];
    };
    expect(body.messages[1]!.content).toEqual([
      { type: 'text', text: 'Caption:\nNaya drop 🔥' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AQID' } },
    ]);
  });

  it('asks for a forced tool call in tool_call mode, and no response_format', async () => {
    const { fetchImpl, calls } = stubFetch({
      body: choiceEnvelope('tool_call'),
    });
    await new ChatCompletionsExtractionModel({
      config: config(),
      fetchImpl,
    }).extract(CAPTION_ONLY);

    const body = JSON.parse(calls[0]!.init.body as string) as Record<string, unknown>;
    expect(body).not.toHaveProperty('response_format');
    expect(body['tool_choice']).toEqual({
      type: 'function',
      function: { name: 'record_extraction' },
    });
    const tools = body['tools'] as { function: Record<string, unknown> }[];
    expect(tools[0]!.function['name']).toBe('record_extraction');
    expect(tools[0]!.function['strict']).toBe(true);
    // The schema on the wire is the one zod derives — stated once, never twice.
    expect(tools[0]!.function['parameters']).toEqual(responseJsonSchema());
  });

  it('asks for response_format in json_schema mode, and no tools', async () => {
    const { fetchImpl, calls } = stubFetch({ body: choiceEnvelope('content') });
    await new ChatCompletionsExtractionModel({
      config: config({ EXTRACTION_OUTPUT_MODE: 'json_schema' }),
      fetchImpl,
    }).extract(CAPTION_ONLY);

    const body = JSON.parse(calls[0]!.init.body as string) as Record<string, unknown>;
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('tool_choice');
    expect(body['response_format']).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'product_extraction',
        strict: true,
        schema: responseJsonSchema(),
      },
    });
  });

  it('carries the OpenRouter attribution headers when they are configured', async () => {
    const { fetchImpl, calls } = stubFetch({
      body: choiceEnvelope('tool_call'),
    });
    await new ChatCompletionsExtractionModel({
      config: config({
        OPENROUTER_SITE_URL: 'https://agent-store.example',
        OPENROUTER_APP_NAME: 'agent-store',
      }),
      fetchImpl,
    }).extract(CAPTION_ONLY);

    expect(calls[0]!.init.headers).toEqual({
      Authorization: 'Bearer or-key',
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://agent-store.example',
      'X-Title': 'agent-store',
    });
  });
});

describe('the envelope the adapter reads', () => {
  it('parses tool-call arguments in tool_call mode', async () => {
    const { fetchImpl } = stubFetch({ body: choiceEnvelope('tool_call') });
    const result = await new ChatCompletionsExtractionModel({
      config: config(),
      fetchImpl,
    }).extract(CAPTION_ONLY);

    expect(result.extraction.name.value).toBe('ZORA Cargo Pants');
    expect(result.extraction.variantStock.value).toEqual({ '32': 3 });
    expect(result.rawResponse).toBe(PAYLOAD);
    expect(result.modelId).toBe('z-ai/glm-5.3-flash');
  });

  it('parses message content in json_schema mode', async () => {
    const { fetchImpl } = stubFetch({ body: choiceEnvelope('content') });
    const result = await new ChatCompletionsExtractionModel({
      config: config({ EXTRACTION_OUTPUT_MODE: 'json_schema' }),
      fetchImpl,
    }).extract(CAPTION_ONLY);

    expect(result.extraction.price.value).toBe(129_900);
  });

  it('turns a refusal into an ExtractionError carrying the refusal', async () => {
    const { fetchImpl } = stubFetch({
      body: {
        choices: [{ finish_reason: 'stop', message: { refusal: 'I cannot help.' } }],
      },
    });
    await expect(
      new ChatCompletionsExtractionModel({
        config: config(),
        fetchImpl,
      }).extract(CAPTION_ONLY),
    ).rejects.toThrow(/Model refused the extraction: I cannot help\./);
  });

  it('refuses a truncated answer rather than parsing half a payload', async () => {
    const { fetchImpl } = stubFetch({
      body: {
        choices: [
          {
            finish_reason: 'length',
            message: { content: PAYLOAD.slice(0, 40) },
          },
        ],
      },
    });
    await expect(
      new ChatCompletionsExtractionModel({
        config: config({ EXTRACTION_OUTPUT_MODE: 'json_schema' }),
        fetchImpl,
      }).extract(CAPTION_ONLY),
    ).rejects.toThrow(/stopped at the 4000-token limit/);
  });

  it('rejects a drifted payload the provider never enforced', async () => {
    // What a gateway that only *accepts* `response_format` actually returns:
    // bare values instead of {value, confidence}, and a keyed variantStock map.
    const drifted = JSON.stringify({
      name: 'ZORA Cargo Pants',
      description: 'Six-pocket cotton cargos.',
      priceText: '₹1,299/-',
      stock: 12,
      variantLabels: ['30', '32'],
      variantStock: { '32': 3 },
    });
    const { fetchImpl } = stubFetch({
      body: choiceEnvelope('tool_call', drifted),
    });

    const error = await new ChatCompletionsExtractionModel({
      config: config(),
      fetchImpl,
    })
      .extract(CAPTION_ONLY)
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ExtractionError);
    // Loud and specific — never a silently empty extraction.
    expect((error as Error).message).toMatch(/did not match the schema at `name`/);
  });
});

describe('vision turned off', () => {
  it('throws on an image before spending a request', async () => {
    const { fetchImpl, calls } = stubFetch({
      body: choiceEnvelope('tool_call'),
    });
    const model = new ChatCompletionsExtractionModel({
      config: config({ EXTRACTION_VISION: 'false' }),
      fetchImpl,
    });

    await expect(model.extract(WITH_IMAGE)).rejects.toThrow(/EXTRACTION_VISION is false/);
    expect(calls).toHaveLength(0);
  });

  it('still runs the caption-only path', async () => {
    const { fetchImpl } = stubFetch({ body: choiceEnvelope('tool_call') });
    const result = await new ChatCompletionsExtractionModel({
      config: config({ EXTRACTION_VISION: 'false' }),
      fetchImpl,
    }).extract(CAPTION_ONLY);

    expect(result.extraction.name.value).toBe('ZORA Cargo Pants');
  });
});
