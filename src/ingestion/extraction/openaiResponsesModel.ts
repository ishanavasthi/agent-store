import {
  ExtractionError,
  type ExtractionInput,
  type ExtractionModel,
  type ExtractionResult,
} from '../types.js';
import { responseJsonSchema } from './payloadSchema.js';
import { INSTRUCTIONS } from './prompt.js';
import { parsePayload, toExtraction } from './toExtraction.js';

/**
 * `ExtractionModel` over the OpenAI Responses API, called with plain `fetch`.
 *
 * No SDK: the whole integration is one POST with a JSON schema attached, and a
 * dependency whose types disagree with the live API has already cost this
 * project a day (see the Razorpay `customer: {}` entry in the engineering log).
 * `fetch` is global in Node 22; `fetchImpl` exists so the request shape and the
 * envelope walk are testable without spending credits.
 *
 * Structured Outputs (`text.format.type: 'json_schema'` with `strict: true`)
 * does the shape-enforcement provider-side, and `parsePayload` does it again
 * here — the second one is the guarantee that survives a provider that only
 * *accepts* a schema (plan §1).
 */

/** Overridable by `EXTRACTION_BASE_URL`; this default is the pinned golden URL. */
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

/**
 * Reasoning effort for the gpt-5 family. `low` keeps a 5-item spike under a
 * minute; the accuracy question is whether the model *reads* the caption right,
 * which is not a long-reasoning problem. Sent only to models that have the
 * parameter — everything else rejects the request outright.
 */
const REASONING_EFFORT = 'low';

/** Generous: a truncated response is an `incomplete` status, not bad JSON. */
const MAX_OUTPUT_TOKENS = 4000;

export interface OpenAIExtractionModelOptions {
  /** e.g. `gpt-5-mini`. Set by `extractionModel.ts`, not by callers. */
  readonly model: string;
  readonly apiKey: string;
  /** No trailing slash. Defaults to `https://api.openai.com/v1`. */
  readonly baseUrl?: string;
  /** Defaults to the global `fetch`. Injected by tests, never in production. */
  readonly fetchImpl?: typeof fetch;
}

export class OpenAIExtractionModel implements ExtractionModel {
  readonly modelId: string;

  readonly #options: OpenAIExtractionModelOptions;

  readonly #fetch: typeof fetch;

  constructor(options: OpenAIExtractionModelOptions) {
    this.modelId = options.model;
    this.#options = options;
    this.#fetch = options.fetchImpl ?? ((...args) => fetch(...args));
  }

  async extract(input: ExtractionInput): Promise<ExtractionResult> {
    const content: Record<string, unknown>[] = [
      { type: 'input_text', text: `Caption:\n${input.caption}` },
    ];
    if (input.image !== null) {
      content.push({
        type: 'input_image',
        image_url: `data:${input.image.mediaType};base64,${input.image.base64}`,
        detail: 'high',
      });
    }

    // Key order is the wire order, and the wire is pinned by
    // `fixtures/extraction/openai-responses-request.golden.json`.
    const body = {
      model: this.#options.model,
      instructions: INSTRUCTIONS,
      input: [{ role: 'user', content }],
      ...(supportsReasoningEffort(this.#options.model)
        ? { reasoning: { effort: REASONING_EFFORT } }
        : {}),
      max_output_tokens: MAX_OUTPUT_TOKENS,
      text: {
        format: {
          type: 'json_schema',
          name: 'product_extraction',
          strict: true,
          schema: responseJsonSchema(),
        },
      },
    };

    const baseUrl = this.#options.baseUrl ?? DEFAULT_BASE_URL;
    const response = await this.#fetch(`${baseUrl}/responses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.#options.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const responseText = await response.text();
    if (!response.ok) {
      // The provider's own words, not just the status — an error message that
      // omits them turns a two-minute fix into an investigation.
      throw new ExtractionError(
        `OpenAI Responses API returned ${String(response.status)}: ${responseText.slice(0, 500)}`,
      );
    }

    const json = parseEnvelope(responseText);
    const modelId = typeof json['model'] === 'string' ? json['model'] : this.#options.model;

    if (json['status'] !== 'completed') {
      throw new ExtractionError(
        `OpenAI response status was ${String(json['status'])}, not completed: ` +
          JSON.stringify(json['incomplete_details'] ?? json['error'] ?? null),
      );
    }

    const outputText = readOutputText(json);

    return { extraction: toExtraction(parsePayload(outputText)), modelId, rawResponse: outputText };
  }
}

/** `reasoning` is a gpt-5-family parameter; other models 400 on it. */
function supportsReasoningEffort(model: string): boolean {
  return model.startsWith('gpt-5');
}

function parseEnvelope(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch (cause) {
    throw new ExtractionError(
      `Could not parse OpenAI response envelope as JSON: ${text.slice(0, 300)}`,
      cause,
    );
  }
}

/**
 * The Responses API returns an array whose first entries are reasoning items
 * with no content; the JSON lives in the `output_text` of the `message` item.
 * `output_text` is a convenience field only some clients synthesise, so this
 * walks the array rather than trusting it to be there.
 */
function readOutputText(json: Record<string, unknown>): string {
  const output = json['output'];
  if (!Array.isArray(output)) {
    throw new ExtractionError('OpenAI response had no `output` array');
  }

  for (const item of output as Record<string, unknown>[]) {
    if (item['type'] !== 'message') continue;
    const parts = item['content'];
    if (!Array.isArray(parts)) continue;
    for (const part of parts as Record<string, unknown>[]) {
      if (part['type'] === 'output_text' && typeof part['text'] === 'string') return part['text'];
      if (part['type'] === 'refusal') {
        throw new ExtractionError(`Model refused the extraction: ${String(part['refusal'])}`);
      }
    }
  }

  throw new ExtractionError('OpenAI response contained no output_text message part');
}
