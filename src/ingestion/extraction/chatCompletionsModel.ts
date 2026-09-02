import {
  ExtractionError,
  type ExtractionInput,
  type ExtractionModel,
  type ExtractionResult,
} from '../types.js';
import type { ExtractionProviderConfig } from './config.js';
import { responseJsonSchema } from './payloadSchema.js';
import { INSTRUCTIONS } from './prompt.js';
import { postJson } from './providerHttp.js';
import { parsePayload, toExtraction } from './toExtraction.js';

/**
 * `ExtractionModel` over an OpenAI-compatible **Chat Completions** endpoint —
 * OpenRouter today, anything speaking the same dialect tomorrow.
 *
 * It is a different wire format from the Responses API, not a different idea:
 * a system message carries the same `INSTRUCTIONS`, the photo rides as an
 * `image_url` part with a data URL, and the reply ends in the same
 * `parsePayload` → `toExtraction` pair. `reasoning` is deliberately absent —
 * it is an OpenAI Responses parameter and a generic gateway 400s on it.
 *
 * Two output modes, because OpenRouter *accepts* `response_format` without
 * enforcing it (plan §1). `tool_call` — a forced call to a single function
 * whose parameters are the schema — is the closest thing to strict mode that
 * survives the round trip. Neither mode is trusted: zod runs on the way back
 * either way, which is what turns a drifted payload into a loud
 * `ExtractionError` instead of a silently empty extraction.
 */

/** The function a `tool_call`-mode provider is forced to call. */
const TOOL_NAME = 'record_extraction';

/** The `json_schema`-mode schema name. Same one the Responses adapter sends. */
const SCHEMA_NAME = 'product_extraction';

/**
 * Generous: truncation shows up as `finish_reason: 'length'`, not bad JSON.
 *
 * Raised from 4000 in S2.3, on evidence: GLM-5.3-Flash in `json_schema` mode
 * hit 4000 on item 23 of the 28-item demo dataset — the one with a full
 * per-variant stock split — and killed a run that had already made 22 live
 * calls. The payload itself is ~400 tokens; what fills the budget is the
 * model's own preamble before the constrained object, which is per-model
 * behaviour we do not control. The cap exists to stop a runaway, not to size
 * the answer, so it is set well clear of any payload this schema can produce.
 */
const MAX_TOKENS = 12_000;

export interface ChatCompletionsExtractionModelOptions {
  readonly config: ExtractionProviderConfig;
  /** Defaults to the global `fetch`. Injected by tests, never in production. */
  readonly fetchImpl?: typeof fetch;
  /** Injected by tests so retry backoff does not make the suite slow. */
  readonly sleepImpl?: (ms: number) => Promise<void>;
}

export class ChatCompletionsExtractionModel implements ExtractionModel {
  readonly modelId: string;

  readonly #options: ChatCompletionsExtractionModelOptions;

  constructor(options: ChatCompletionsExtractionModelOptions) {
    this.modelId = options.config.model;
    this.#options = options;
  }

  async extract(input: ExtractionInput): Promise<ExtractionResult> {
    const config = this.#options.config;

    // Before the request, not after: a caption-only extraction of a post whose
    // meaning is in the photo is worse than a refusal, and a silent drop is
    // how a catalog fills with confident nonsense.
    if (input.image !== null && !config.vision) {
      throw new ExtractionError(
        'An image was supplied but EXTRACTION_VISION is false, so this provider/model ' +
          'is configured as text-only. Unset EXTRACTION_VISION or submit the caption alone.',
      );
    }

    const content: Record<string, unknown>[] = [
      { type: 'text', text: `Caption:\n${input.caption}` },
    ];
    if (input.image !== null) {
      content.push({
        type: 'image_url',
        image_url: {
          url: `data:${input.image.mediaType};base64,${input.image.base64}`,
        },
      });
    }

    const body = {
      model: config.model,
      messages: [
        { role: 'system', content: INSTRUCTIONS },
        { role: 'user', content },
      ],
      max_tokens: MAX_TOKENS,
      ...(config.outputMode === 'json_schema'
        ? {
            response_format: {
              type: 'json_schema',
              json_schema: {
                name: SCHEMA_NAME,
                strict: true,
                schema: responseJsonSchema(),
              },
            },
          }
        : {
            tools: [
              {
                type: 'function',
                function: {
                  name: TOOL_NAME,
                  description: 'Record the catalog fields extracted from the post.',
                  parameters: responseJsonSchema(),
                  strict: true,
                },
              },
            ],
            tool_choice: { type: 'function', function: { name: TOOL_NAME } },
          }),
    };

    const responseText = await postJson({
      url: `${config.baseUrl}/chat/completions`,
      apiKey: config.apiKey,
      body,
      timeoutMs: config.timeoutMs,
      extraHeaders: config.extraHeaders,
      label: providerLabel(config),
      ...(this.#options.fetchImpl === undefined ? {} : { fetchImpl: this.#options.fetchImpl }),
      ...(this.#options.sleepImpl === undefined ? {} : { sleepImpl: this.#options.sleepImpl }),
    });

    const json = parseEnvelope(responseText, config);
    const modelId = typeof json['model'] === 'string' ? json['model'] : config.model;
    const payloadText = readPayloadText(json, config.outputMode);

    return {
      extraction: toExtraction(parsePayload(payloadText)),
      modelId,
      rawResponse: payloadText,
    };
  }
}

function providerLabel(config: ExtractionProviderConfig): string {
  return config.provider === 'openrouter' ? 'OpenRouter' : 'The Chat Completions provider';
}

function parseEnvelope(text: string, config: ExtractionProviderConfig): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch (cause) {
    throw new ExtractionError(
      `Could not parse the ${providerLabel(config)} response envelope as JSON: ${text.slice(0, 300)}`,
      cause,
    );
  }
}

/**
 * The JSON lives in one of two places depending on the output mode, and three
 * things that are not JSON at all can arrive instead: a refusal, a truncated
 * answer, or an empty choice list. All three are errors with their own words.
 */
function readPayloadText(json: Record<string, unknown>, outputMode: string): string {
  const choices = json['choices'];
  const choice = Array.isArray(choices)
    ? (choices[0] as Record<string, unknown> | undefined)
    : undefined;
  if (choice === undefined) {
    throw new ExtractionError('The provider response contained no choices');
  }

  const message = (choice['message'] ?? {}) as Record<string, unknown>;
  const refusal = message['refusal'];
  if (typeof refusal === 'string' && refusal.trim() !== '') {
    throw new ExtractionError(`Model refused the extraction: ${refusal}`);
  }
  if (choice['finish_reason'] === 'length') {
    throw new ExtractionError(
      `The model stopped at the ${String(MAX_TOKENS)}-token limit before finishing the payload`,
    );
  }

  if (outputMode === 'tool_call') {
    const toolCalls = message['tool_calls'];
    const first = Array.isArray(toolCalls)
      ? (toolCalls[0] as Record<string, unknown> | undefined)
      : undefined;
    const fn = (first?.['function'] ?? {}) as Record<string, unknown>;
    const args = fn['arguments'];
    if (typeof args !== 'string') {
      throw new ExtractionError(
        `The provider was asked to call \`${TOOL_NAME}\` and returned no tool-call arguments ` +
          `(finish_reason: ${String(choice['finish_reason'])})`,
      );
    }
    return args;
  }

  const content = message['content'];
  if (typeof content !== 'string') {
    throw new ExtractionError(
      `The provider returned no message content (finish_reason: ${String(choice['finish_reason'])})`,
    );
  }
  return content;
}
