import { describe, expect, it } from 'vitest';
import { CanonicalJsonError, canonicalJson, sha256Hex } from './canonicalJson.js';

describe('canonicalJson', () => {
  it('sorts object keys recursively, including inside arrays', () => {
    expect(canonicalJson({ b: 1, a: { d: 4, c: [{ z: 0, y: 1 }] } })).toBe(
      '{"a":{"c":[{"y":1,"z":0}],"d":4},"b":1}',
    );
  });

  it('is independent of property insertion order', () => {
    const one = { agentId: 'agt_1', budgetPaise: 500000, want: 'a tee' };
    const two = { want: 'a tee', budgetPaise: 500000, agentId: 'agt_1' };
    expect(canonicalJson(one)).toBe(canonicalJson(two));
  });

  it('keeps arrays in the given order', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalJson([3, 1, 2])).not.toBe(canonicalJson([1, 2, 3]));
  });

  it('emits no whitespace and standard JSON string escapes', () => {
    expect(canonicalJson({ 'a b': 'say "hi"\n' })).toBe('{"a b":"say \\"hi\\"\\n"}');
  });

  it('passes non-ASCII text through unescaped', () => {
    expect(canonicalJson({ want: 'चाय ☕' })).toBe('{"want":"चाय ☕"}');
  });

  it('serializes primitives as JSON literals', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(false)).toBe('false');
    expect(canonicalJson(0)).toBe('0');
    expect(canonicalJson(-7)).toBe('-7');
    expect(canonicalJson(129900)).toBe('129900');
  });

  it('rejects undefined at top level, as an array element, and as a property value', () => {
    expect(() => canonicalJson(undefined)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson([undefined])).toThrow(CanonicalJsonError);
    // A property holding undefined is an error, never silently skipped — a
    // client serializer that drops the key would produce a different hash.
    expect(() => canonicalJson({ a: undefined })).toThrow(CanonicalJsonError);
  });

  it('rejects non-finite numbers', () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ amountPaise: Number.NEGATIVE_INFINITY })).toThrow(
      CanonicalJsonError,
    );
  });

  it('rejects non-plain objects and non-JSON value types', () => {
    expect(() => canonicalJson(new Date())).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(new Map())).toThrow(CanonicalJsonError);
    expect(() => canonicalJson({ createdAt: new Date() })).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(10n)).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(() => 'nope')).toThrow(CanonicalJsonError);
    expect(() => canonicalJson(Symbol('nope'))).toThrow(CanonicalJsonError);
  });

  it('accepts a null-prototype object', () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare['a'] = 1;
    expect(canonicalJson(bare)).toBe('{"a":1}');
  });
});

describe('sha256Hex', () => {
  it('matches the published SHA-256 test vectors', () => {
    // FIPS 180-4 vectors: the empty string and "abc".
    expect(sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('hashes UTF-8 bytes, so unicode input is stable and distinct', () => {
    expect(sha256Hex('चाय')).toBe(sha256Hex('चाय'));
    expect(sha256Hex('चाय')).not.toBe(sha256Hex('chai'));
  });
});
