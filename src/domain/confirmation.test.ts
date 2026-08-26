import { describe, expect, it } from 'vitest';
import { normalizeSubmission, type ConfirmationSubmission } from './confirmation.js';
import { ValidationError } from './refusal.js';

/**
 * The pure half of the T13 publish gate: every rule that decides whether a
 * confirmation submission *can* publish, no database required (the
 * `pipeline.ts` testing split). The row-level rules — unknown variantId,
 * product status, the concurrent-confirm guard — live in the integration
 * suite (src/http/merchantConfirmation.integration.test.ts).
 */

function submission(overrides: Partial<ConfirmationSubmission> = {}): ConfirmationSubmission {
  return {
    title: 'RAAT Oversized Tee',
    description: 'Jet black, drop shoulders.',
    variants: [{ label: null, pricePaise: 119900, stock: 18 }],
    ...overrides,
  };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof ValidationError) return error.code;
    throw error;
  }
  throw new Error('expected a ValidationError');
}

describe('normalizeSubmission', () => {
  it('trims text fields and turns an empty description into null', () => {
    const normalized = normalizeSubmission(
      submission({ title: '  RAAT Tee  ', description: '   ' }),
    );
    expect(normalized.title).toBe('RAAT Tee');
    expect(normalized.description).toBeNull();
  });

  it('marks the single null-label variant as the implicit default', () => {
    const normalized = normalizeSubmission(submission());
    expect(normalized.variants).toEqual([
      { variantId: null, label: null, isDefault: true, pricePaise: 119900, stock: 18 },
    ]);
  });

  it('labelled variants are never the default and keep their stated counts', () => {
    const normalized = normalizeSubmission(
      submission({
        variants: [
          { variantId: 'var_a', label: ' S ', pricePaise: 99900, stock: 4 },
          { label: 'M', pricePaise: 99900, stock: 0 },
        ],
      }),
    );
    expect(normalized.variants).toEqual([
      { variantId: 'var_a', label: 'S', isDefault: false, pricePaise: 99900, stock: 4 },
      { variantId: null, label: 'M', isDefault: false, pricePaise: 99900, stock: 0 },
    ]);
  });

  it('refuses an empty title', () => {
    expect(codeOf(() => normalizeSubmission(submission({ title: '  ' })))).toBe(
      'INVALID_CONFIRMATION',
    );
  });

  it('refuses an empty variant list', () => {
    expect(codeOf(() => normalizeSubmission(submission({ variants: [] })))).toBe(
      'INVALID_CONFIRMATION',
    );
  });

  it.each([
    ['zero price', { label: null, pricePaise: 0, stock: 5 }],
    ['negative price', { label: null, pricePaise: -100, stock: 5 }],
    ['fractional price', { label: null, pricePaise: 1299.5, stock: 5 }],
    ['negative stock', { label: null, pricePaise: 119900, stock: -1 }],
    ['fractional stock', { label: null, pricePaise: 119900, stock: 2.5 }],
    ['NaN stock', { label: null, pricePaise: 119900, stock: Number.NaN }],
  ])('refuses %s — never a number checkout cannot trust', (_name, variant) => {
    expect(codeOf(() => normalizeSubmission(submission({ variants: [variant] })))).toBe(
      'INVALID_CONFIRMATION',
    );
  });

  it('refuses a null label among several variants — null means THE single default', () => {
    expect(
      codeOf(() =>
        normalizeSubmission(
          submission({
            variants: [
              { label: null, pricePaise: 99900, stock: 1 },
              { label: 'M', pricePaise: 99900, stock: 1 },
            ],
          }),
        ),
      ),
    ).toBe('INVALID_CONFIRMATION');
  });

  it('refuses a blank label — use null for the default Variant instead', () => {
    expect(
      codeOf(() =>
        normalizeSubmission(submission({ variants: [{ label: '  ', pricePaise: 99900, stock: 1 }] })),
      ),
    ).toBe('INVALID_CONFIRMATION');
  });

  it('refuses duplicate labels under the same normalisation the pipeline matches with', () => {
    // "UK 10" and "uk10" are the same label to the stock matcher, so they are
    // the same label here too — two rows would make one of them unreachable.
    expect(
      codeOf(() =>
        normalizeSubmission(
          submission({
            variants: [
              { label: 'UK 10', pricePaise: 99900, stock: 1 },
              { label: 'uk10', pricePaise: 99900, stock: 2 },
            ],
          }),
        ),
      ),
    ).toBe('INVALID_CONFIRMATION');
  });

  it('refuses the same variantId submitted twice', () => {
    expect(
      codeOf(() =>
        normalizeSubmission(
          submission({
            variants: [
              { variantId: 'var_a', label: 'S', pricePaise: 99900, stock: 1 },
              { variantId: 'var_a', label: 'M', pricePaise: 99900, stock: 2 },
            ],
          }),
        ),
      ),
    ).toBe('INVALID_CONFIRMATION');
  });
});
