import { createHash } from 'node:crypto';

/**
 * Canonical JSON + hashing for the mandate chain (CONTEXT.md → Mandate chain).
 *
 * Every mandate hash and every mandate signature is computed over the string
 * this module produces, so buyer and merchant must agree on it byte for byte.
 * A client-side buyer (the Agent SDK eval buyer — DECISIONS.md "Split key
 * custody") reimplements it from this spec alone:
 *
 * 1. `null`, `true`, `false` serialize as those literals.
 * 2. Numbers must be finite. They serialize per ECMAScript Number→String
 *    (what `JSON.stringify` emits). Mandate payloads only ever carry integers
 *    (paise, quantities), which render as plain decimal digits with an
 *    optional leading `-`, e.g. `129900`; `-0` renders as `0`.
 * 3. Strings serialize per `JSON.stringify`: `"`, `\`, and control characters
 *    (U+0000–U+001F) escaped as JSON requires; every other character emitted
 *    verbatim — no `\uXXXX` escaping of non-ASCII; unpaired surrogates are
 *    escaped as `\uXXXX` (well-formed `JSON.stringify` semantics).
 * 4. Arrays: `[` + elements serialized in the given order, joined by `,`, + `]`.
 * 5. Objects: own enumerable string-keyed properties only, keys sorted by
 *    UTF-16 code unit order, serialized as `{"key":value,...}`. No whitespace
 *    anywhere.
 * 6. Everything else throws, never coerces or skips: `undefined` (including as
 *    an array element or a property value), `NaN`/`±Infinity`, bigints,
 *    functions, symbols, and non-plain objects (`Date`, `Map`, buffers, class
 *    instances — a serializable object's prototype is `Object.prototype` or
 *    `null`).
 * 7. A payload's hash is the lowercase hex SHA-256 of the UTF-8 bytes of its
 *    canonical string.
 */

export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalJsonError';
  }
}

export function canonicalJson(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new CanonicalJsonError(`Cannot canonicalize non-finite number: ${String(value)}`);
      }
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      // undefined, bigint, function, symbol.
      throw new CanonicalJsonError(`Cannot canonicalize value of type ${typeof value}`);
  }
  if (Array.isArray(value)) {
    return `[${value.map((element) => canonicalJson(element)).join(',')}]`;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new CanonicalJsonError(
      `Cannot canonicalize non-plain object ${Object.prototype.toString.call(value)}`,
    );
  }
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${entries.join(',')}}`;
}

/** Lowercase hex SHA-256 over the UTF-8 bytes of `text`. */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
