import { describe, expect, it } from 'vitest';
import { modelPayloadSchema, responseJsonSchema } from './payloadSchema.js';

/**
 * The schema pin. `responseJsonSchema()` is derived from `modelPayloadSchema`,
 * but what goes on the wire must not move: the committed gpt-5-mini run was
 * produced against the literal below, and the accuracy numbers the repo quotes
 * are only about that request. If a zod upgrade changes the derivation, this
 * fails here rather than silently in a live run nobody re-scores.
 */

/** The hand-written literal `openaiExtractionModel.ts` sent before S2.1. */
function fieldSchema(valueSchema: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'object',
    properties: { value: valueSchema, confidence: { type: 'number' } },
    required: ['value', 'confidence'],
    additionalProperties: false,
  };
}

const LEGACY_RESPONSE_SCHEMA = {
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
};

describe('responseJsonSchema', () => {
  it('derives exactly the schema literal the committed run was produced with', () => {
    expect(responseJsonSchema()).toEqual(LEGACY_RESPONSE_SCHEMA);
  });

  it('carries no `$schema` annotation into the inlined request', () => {
    expect(Object.keys(responseJsonSchema())).not.toContain('$schema');
  });

  it('states nullables as a type union, not an anyOf', () => {
    // Both are valid JSON Schema; only one is what the provider has been sent.
    expect(JSON.stringify(responseJsonSchema())).not.toContain('anyOf');
  });

  it('sends no safe-integer bounds zod would otherwise attach', () => {
    const json = JSON.stringify(responseJsonSchema());
    expect(json).not.toContain('minimum');
    expect(json).not.toContain('maximum');
  });
});

describe('modelPayloadSchema', () => {
  it('accepts the shape Structured Outputs produces', () => {
    const payload = {
      name: { value: 'RAAT Oversized Tee', confidence: 0.9 },
      description: { value: 'Heavyweight cotton tee.', confidence: 0.9 },
      priceText: { value: '₹1,199/-', confidence: 0.95 },
      stock: { value: null, confidence: 0 },
      variantLabels: { value: ['S', 'M'], confidence: 0.95 },
      variantStock: { value: [{ label: 'S', count: 3 }], confidence: 0.8 },
    };
    expect(modelPayloadSchema.safeParse(payload).success).toBe(true);
  });
});
