import { describe, expect, it } from 'vitest';
import { capPaiseFromInput, newAgentToken, publicKeyFromInput } from './agents.js';
import { generateSigningKeypair } from './keys.js';
import { ValidationError } from './refusal.js';

describe('publicKeyFromInput', () => {
  it('accepts a wire-encoded Ed25519 public key, trimmed', () => {
    const { publicKey } = generateSigningKeypair();
    expect(publicKeyFromInput(publicKey)).toBe(publicKey);
    expect(publicKeyFromInput(`  ${publicKey}\n`)).toBe(publicKey);
  });

  it('rejects garbage as INVALID_PUBLIC_KEY — a validation error, never a Refusal', () => {
    // A stored garbage key would make every later signature check a lie; the
    // registration door is where it must fail (CONTEXT.md → Failure vocabulary:
    // malformed input is a plain validation error).
    for (const value of ['', '   ', 'not-a-key', 'aGVsbG8=', generateSigningKeypair().privateKey]) {
      try {
        publicKeyFromInput(value);
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError);
        expect((error as ValidationError).code).toBe('INVALID_PUBLIC_KEY');
      }
    }
  });
});

describe('capPaiseFromInput', () => {
  it('accepts a positive integer number of paise unchanged', () => {
    expect(capPaiseFromInput(500000)).toBe(500000);
    expect(capPaiseFromInput(1)).toBe(1);
  });

  it('rejects a float rather than rounding it', () => {
    // "Rejected/normalized to integer paise" (issue #4): no silent rounding —
    // the number stored must be exactly the number the buyer declared, so a
    // rupee-shaped 4999.5 is an INVALID_CAP validation error, never 4999 or 5000.
    for (const value of [4999.5, 0.1, 500000.000001]) {
      expect(() => capPaiseFromInput(value)).toThrowError(ValidationError);
      try {
        capPaiseFromInput(value);
      } catch (error) {
        expect((error as ValidationError).code).toBe('INVALID_CAP');
      }
    }
  });

  it('rejects zero, negatives, and non-finite numbers', () => {
    // A Cap of 0 authorizes nothing — surfacing the mistake at registration
    // beats an inevitable OVER_CAP at first checkout.
    for (const value of [0, -1, -500000, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(() => capPaiseFromInput(value)).toThrowError(ValidationError);
    }
  });

  it('throws a ValidationError, not a Refusal — a bad Cap is malformed input, not policy', () => {
    // CONTEXT.md → Failure vocabulary: Refusals are the trust layer saying no
    // on policy; a malformed Cap never reaches policy at all.
    try {
      capPaiseFromInput(-5);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).toPayload()).toEqual({
        code: 'INVALID_CAP',
        message: expect.stringContaining('positive integer number of paise') as unknown as string,
      });
    }
  });
});

describe('newAgentToken', () => {
  it('is prefixed so a token is never mistaken for an agent id', () => {
    expect(newAgentToken()).toMatch(/^agt_tok_[A-Za-z0-9_-]{43}$/);
  });

  it('mints a distinct 256-bit token every time', () => {
    const seen = new Set(Array.from({ length: 100 }, () => newAgentToken()));
    expect(seen.size).toBe(100);
  });
});
