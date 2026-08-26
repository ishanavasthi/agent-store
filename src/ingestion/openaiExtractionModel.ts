import { parseRupeePrice } from './price.js';
import {
  ExtractionError,
  type ExtractedField,
  type ExtractionInput,
  type ExtractionModel,
  type ExtractionResult,
  type ProductExtraction,
} from './types.js';

/**
 * `ExtractionModel` over the OpenAI Responses API, called with plain `fetch`.
 *
 * No SDK: the whole integration is one POST with a JSON schema attached, and a
 * dependency whose types disagree with the live API has already cost this
 * project a day (see the Razorpay `customer: {}` entry in the engineering log).
 * `fetch` is global in Node 22.
 *
 * Structured Outputs (`text.format.type: 'json_schema'` with `strict: true`)
 * does the shape-enforcement, so the parsing below is about *trust*, not about
 * shape: confidences get clamped, the price gets re-derived from the verbatim
 * text by our own code, and a null value always ends up with confidence 0.
 */

const RESPONSES_URL = 'https://api.openai.com/v1/responses';

/**
 * Says what a *field* is before it asks for any. The two rules that earn their
 * place here are the two that captions get wrong most: the sale price is the
 * one a buyer pays (a struck-through MRP is not a price), and a per-customer
 * purchase limit is not stock. Both are guessed wrong by default.
 */
const INSTRUCTIONS = `You extract catalog data from an Indian D2C merchant's social-media post.

You will be given the merchant's caption and usually a photo of the product. Captions are
Hinglish (Hindi written in Latin script, mixed with English), full of emoji, and written for
humans, not machines. That is normal input, not an error.

Extract these fields:

- name: the short product title a merchant would put on a listing, in Title Case, no emoji
  and no price: the caption's name for the product plus the full product type, stated
  exactly once. Expand a colloquial truncation to the full garment type ("ZORA cargos" →
  "ZORA Cargo Pants"; "MOTI snapback" → "MOTI Snapback Cap"); but when the caption's name
  already ends in the product type ("ROSHNI hoodie", "KESAR beanie") that is the whole
  title ("ROSHNI Hoodie") — never append a second type word ("ROSHNI Hoodie Sweatshirt"
  is wrong). If the caption never names the product at all, name it by what the photo
  shows it to be (e.g. "Corduroy Bucket Hat") — what the item IS, never a feature of it
  ("Water Resistant Bag" is a feature, not a name). Do not invent a brand name.
- description: one or two sentences of the material/fit/construction details stated in the
  caption. Only what the caption or photo supports; never marketing you made up.
- priceText: the price a buyer actually pays, copied VERBATIM from the caption including its
  currency mark and punctuation (e.g. "₹1,299/-"). If the caption shows both a struck-through
  or "MRP" price and a lower selling price, copy the LOWER selling price — the one being
  charged. Copy exactly one amount. Shipping thresholds ("free shipping above 999"), COD
  eligibility limits, COD surcharges, and another product's price mentioned in passing are
  not this product's price. If no price is stated, null.
- stock: the number of units available for the whole product, as an integer, ONLY if the
  caption states a count ("12 pieces left", "20 pcs ready", "30 pcs total across both
  colours"). A stated total across sizes/colours IS product stock. A per-customer purchase
  limit ("2 per customer max") is NOT stock. Vague availability ("stock ready", "restocked",
  "in stock", "almost gone", "DM to check") is NOT stock — return null. A count stated for
  only ONE size/colour is not product stock either — it goes in variantStock. Guessing here
  puts an invented quantity in a live catalog.
- variantLabels: the size or colour options a buyer CHOOSES BETWEEN, exactly as written
  ("S", "M", "L", "XL", "30", "32", "lilac"). Empty array if the caption offers no choice.
  "free size" / "one size" / "one size fits all" / "adjustable" means there is NO choice —
  that is an empty array, never a label. Colours that are the contents of a pack you buy
  whole ("pack of 3 — brown, beige, white") are not choices either — empty array. A phrase
  describing the item ("one size fits all, beige") is a description, not two variants.
- variantStock: counts the caption states for SPECIFIC variants, as {label, count} pairs
  whose labels come from variantLabels ("32 mein sirf 3 pieces" → [{"label": "32",
  "count": 3}]; "S: 4 pcs | M: 7 pcs" → both pairs). Empty array when none are stated —
  the common case. Vibes about one size ("UK 10 almost gone") are NOT a count. Never invent
  a split from a product-level total.

Every field carries a confidence from 0 to 1: how sure you are that this exact value is what
the merchant meant. Be honest and use the range — a field you had to infer from the photo, or
a caption with two plausible readings, is not a 0.95. A null value takes confidence 0.`;

/**
 * What the model returns, before we stop trusting it: the same per-field shape
 * the seam publishes, since Structured Outputs is what puts it in that shape.
 */
interface ModelPayload {
  readonly name: ExtractedField<string>;
  readonly description: ExtractedField<string>;
  readonly priceText: ExtractedField<string>;
  readonly stock: ExtractedField<number>;
  readonly variantLabels: ExtractedField<readonly string[]>;
  /**
   * Pairs on the wire, not a keyed object: Structured Outputs strict mode
   * requires every object property to be declared, which rules out a map with
   * caption-determined keys. `toExtraction` folds the pairs into the record
   * the seam publishes.
   */
  readonly variantStock: ExtractedField<readonly { label: string; count: number }[]>;
}

/** Structured Outputs strict mode: every key required, no extra keys, nullable via unions. */
function fieldSchema(valueSchema: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'object',
    properties: { value: valueSchema, confidence: { type: 'number' } },
    required: ['value', 'confidence'],
    additionalProperties: false,
  };
}

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    name: fieldSchema({ type: ['string', 'null'] }),
    description: fieldSchema({ type: ['string', 'null'] }),
    priceText: fieldSchema({ type: ['string', 'null'] }),
    stock: fieldSchema({ type: ['integer', 'null'] }),
    variantLabels: fieldSchema({ type: 'array', items: { type: 'string' } }),
    variantStock: fieldSchema({
      type: 'array',
      items: {
        type: 'object',
        properties: { label: { type: 'string' }, count: { type: 'integer' } },
        required: ['label', 'count'],
        additionalProperties: false,
      },
    }),
  },
  required: ['name', 'description', 'priceText', 'stock', 'variantLabels', 'variantStock'],
  additionalProperties: false,
} as const;

/**
 * Reasoning effort for the gpt-5 family. `low` keeps a 5-item spike under a
 * minute; the accuracy question is whether the model *reads* the caption right,
 * which is not a long-reasoning problem.
 */
const REASONING_EFFORT = 'low';

/** Generous: a truncated response is an `incomplete` status, not bad JSON. */
const MAX_OUTPUT_TOKENS = 4000;

export interface OpenAIExtractionModelOptions {
  /** e.g. `gpt-5-mini`. Set by `extractionModel.ts`, not by callers. */
  readonly model: string;
  readonly apiKey: string;
}

export class OpenAIExtractionModel implements ExtractionModel {
  readonly modelId: string;

  readonly #options: OpenAIExtractionModelOptions;

  constructor(options: OpenAIExtractionModelOptions) {
    this.modelId = options.model;
    this.#options = options;
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

    const body = {
      model: this.#options.model,
      instructions: INSTRUCTIONS,
      input: [{ role: 'user', content }],
      reasoning: { effort: REASONING_EFFORT },
      max_output_tokens: MAX_OUTPUT_TOKENS,
      text: {
        format: {
          type: 'json_schema',
          name: 'product_extraction',
          strict: true,
          schema: RESPONSE_SCHEMA,
        },
      },
    };

    const response = await fetch(RESPONSES_URL, {
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

    const json = parseJson(responseText, 'OpenAI response envelope');
    const modelId = typeof json['model'] === 'string' ? json['model'] : this.#options.model;

    if (json['status'] !== 'completed') {
      throw new ExtractionError(
        `OpenAI response status was ${String(json['status'])}, not completed: ` +
          JSON.stringify(json['incomplete_details'] ?? json['error'] ?? null),
      );
    }

    const outputText = readOutputText(json);
    const payload = parseJson(outputText, 'extraction payload') as unknown as ModelPayload;

    return { extraction: toExtraction(payload), modelId, rawResponse: outputText };
  }
}

function parseJson(text: string, what: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch (cause) {
    throw new ExtractionError(`Could not parse ${what} as JSON: ${text.slice(0, 300)}`, cause);
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

/** A null value never carries confidence, whatever the model claimed. */
function field<T>(value: T | null, confidence: unknown): ExtractedField<T> {
  if (value === null) return { value: null, confidence: 0 };
  const raw = typeof confidence === 'number' && Number.isFinite(confidence) ? confidence : 0;
  return { value, confidence: Math.min(1, Math.max(0, raw)) };
}

function toExtraction(payload: ModelPayload): ProductExtraction {
  const priceText = payload.priceText?.value ?? null;
  const parsedPrice = priceText === null ? null : parseRupeePrice(priceText);

  return {
    name: field(nonEmpty(payload.name?.value), payload.name?.confidence),
    description: field(nonEmpty(payload.description?.value), payload.description?.confidence),
    // A price we could not parse is not a price, however sure the model was.
    price: field(parsedPrice, payload.priceText?.confidence),
    priceText: field(priceText, payload.priceText?.confidence),
    stock: field(
      typeof payload.stock?.value === 'number' && Number.isSafeInteger(payload.stock.value)
        ? payload.stock.value
        : null,
      payload.stock?.confidence,
    ),
    variantLabels: field(
      Array.isArray(payload.variantLabels?.value) ? payload.variantLabels.value : [],
      payload.variantLabels?.confidence,
    ),
    variantStock: field(
      toVariantStockRecord(payload.variantStock?.value),
      payload.variantStock?.confidence,
    ),
  };
}

/** Fold the wire pairs into the seam's record, dropping anything malformed. */
function toVariantStockRecord(
  pairs: readonly { label: string; count: number }[] | null | undefined,
): Record<string, number> {
  const record: Record<string, number> = {};
  if (!Array.isArray(pairs)) return record;
  for (const pair of pairs) {
    const label = typeof pair.label === 'string' ? pair.label.trim() : '';
    if (label === '') continue;
    if (typeof pair.count !== 'number' || !Number.isSafeInteger(pair.count) || pair.count < 0)
      continue;
    record[label] = pair.count;
  }
  return record;
}

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}
