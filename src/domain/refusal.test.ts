import { describe, expect, it } from 'vitest';
import { Refusal, ValidationError } from './refusal.js';

describe('Refusal', () => {
  it('carries the CONTEXT.md payload shape', () => {
    const refusal = new Refusal({
      code: 'OUT_OF_STOCK',
      reason: 'Only 2 left; 5 requested',
      recoverable: true,
    });
    expect(refusal.toPayload()).toEqual({
      code: 'OUT_OF_STOCK',
      reason: 'Only 2 left; 5 requested',
      recoverable: true,
    });
  });

  it('omits retryAfter entirely when there is nothing to wait for', () => {
    const payload = new Refusal({
      code: 'OVER_CAP',
      reason: 'Cap exhausted for this registration',
      recoverable: false,
    }).toPayload();
    expect('retryAfter' in payload).toBe(false);
  });

  it('includes retryAfter when the wait is finite', () => {
    const payload = new Refusal({
      code: 'OUT_OF_STOCK',
      reason: 'Restocking',
      recoverable: true,
      retryAfter: 3600,
    }).toPayload();
    expect(payload.retryAfter).toBe(3600);
  });

  it('is an Error, so an unhandled one still surfaces', () => {
    expect(new Refusal({ code: 'OVER_BUDGET', reason: 'x', recoverable: false })).toBeInstanceOf(
      Error,
    );
  });
});

describe('ValidationError', () => {
  it('has a different shape from a Refusal', () => {
    // The two vocabulary categories must not be confusable: a validation error
    // has no `recoverable`, because it is not a policy decision at all.
    const payload = new ValidationError('INVALID_QUANTITY', 'must be positive').toPayload();
    expect(payload).toEqual({ code: 'INVALID_QUANTITY', message: 'must be positive' });
    expect('recoverable' in payload).toBe(false);
    expect('reason' in payload).toBe(false);
  });

  it('is not a Refusal and a Refusal is not one of these', () => {
    const validation = new ValidationError('VARIANT_NOT_FOUND', 'nope');
    const refusal = new Refusal({ code: 'OUT_OF_STOCK', reason: 'nope', recoverable: true });
    expect(validation).not.toBeInstanceOf(Refusal);
    expect(refusal).not.toBeInstanceOf(ValidationError);
  });
});
