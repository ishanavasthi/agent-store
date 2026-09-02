import { z } from 'zod';

/**
 * The extraction payload, stated once — as a zod schema.
 *
 * Two things are derived from this one declaration: the JSON Schema sent to the
 * provider (`responseJsonSchema()`), and the validation every payload passes
 * through before `toExtraction` reads it. They used to be two independent
 * statements — a hand-written schema literal on the wire and a bare `as` cast
 * on the way back — which is exactly the pair that drifts apart silently.
 *
 * Validation is not redundant with Structured Outputs. The OpenAI Responses
 * path enforces the schema provider-side; OpenRouter accepts `response_format`
 * and does not enforce it (plan §1). Zod is the guarantee that holds on both.
 */

const fieldSchema = <T extends z.ZodType>(value: T) =>
  z.strictObject({ value, confidence: z.number() });

export const modelPayloadSchema = z.strictObject({
  name: fieldSchema(z.string().nullable()),
  description: fieldSchema(z.string().nullable()),
  priceText: fieldSchema(z.string().nullable()),
  stock: fieldSchema(z.int().nullable()),
  variantLabels: fieldSchema(z.array(z.string())),
  /**
   * Pairs on the wire, not a keyed object: Structured Outputs strict mode
   * requires every object property to be declared, which rules out a map with
   * caption-determined keys. `toExtraction` folds the pairs into the record
   * the seam publishes.
   */
  variantStock: fieldSchema(z.array(z.strictObject({ label: z.string(), count: z.int() }))),
});

export type ModelPayload = z.infer<typeof modelPayloadSchema>;

/**
 * The JSON Schema the provider gets, derived from `modelPayloadSchema`.
 *
 * `z.toJSONSchema` is draft 2020-12 and correct, but three of its choices are
 * not what the OpenAI Responses request has been sending — and the wire bytes
 * are pinned by `fixtures/extraction/openai-responses-request.golden.json`, so
 * the derivation bends to the wire, not the other way round:
 *
 *   1. `anyOf: [{type: T}, {type: 'null'}]` → `type: [T, 'null']`. Both are
 *      valid; only the second is what the committed run was produced with.
 *   2. `z.int()` carries `minimum`/`maximum` at the safe-integer bounds. They
 *      say nothing a model can act on and were never sent.
 *   3. `$schema` is a document-level annotation, not part of an inlined schema.
 */
export function responseJsonSchema(): Record<string, unknown> {
  const derived = z.toJSONSchema(modelPayloadSchema) as Record<string, unknown>;
  delete derived['$schema'];
  return pinToWireForm(derived) as Record<string, unknown>;
}

function pinToWireForm(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(pinToWireForm);
  if (node === null || typeof node !== 'object') return node;

  const source = node as Record<string, unknown>;
  const nullableOf = readNullableUnion(source);
  if (nullableOf !== null) return { type: [nullableOf, 'null'] };

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (source['type'] === 'integer' && (key === 'minimum' || key === 'maximum')) continue;
    result[key] = pinToWireForm(value);
  }
  return result;
}

/** `{anyOf: [{type: T}, {type: 'null'}]}` → `T`, and nothing else. */
function readNullableUnion(node: Record<string, unknown>): string | null {
  const options = node['anyOf'];
  if (!Array.isArray(options) || options.length !== 2 || Object.keys(node).length !== 1) return null;

  const branches = options as Record<string, unknown>[];
  const nonNull = branches.filter((b) => b['type'] !== 'null');
  if (nonNull.length !== 1 || branches.length - nonNull.length !== 1) return null;

  const type = nonNull[0]?.['type'];
  return typeof type === 'string' ? type : null;
}
