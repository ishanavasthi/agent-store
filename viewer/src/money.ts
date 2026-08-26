/**
 * Money display for the viewer. Mirrors the server's rule (CONTEXT.md → Money):
 * amounts are integer paise, INR only, and the paise integer is the fact — the
 * ₹ rendering is derived from it by integer math and shown second.
 */

/** Indian digit grouping: last three digits, then pairs — 129900 → "1,29,900". */
function groupIndian(digits: string): string {
  const head = digits.length > 3 ? digits.slice(0, -3) : '';
  const tail = digits.length > 3 ? digits.slice(-3) : digits;
  return head === '' ? tail : `${head.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${tail}`;
}

export interface PaiseDisplay {
  /** e.g. "1,29,900 paise" — the machine truth, always shown. */
  readonly paise: string;
  /** e.g. "₹1,299.00" — derived, secondary. Null when the value is not usable paise. */
  readonly rupees: string | null;
}

/**
 * Accepts unknown because payloads are untrusted JSON: anything that is not a
 * non-negative safe integer renders verbatim rather than pretending to be money.
 */
/**
 * The confirmation form's price input speaks rupees (what a caption and a
 * merchant both speak) but the API speaks integer paise — this pair converts
 * between them by *string* math only, honouring the no-floating-point rule.
 */

/** `129900` → `"1299"`, `129950` → `"1299.50"`, null → `""` (nothing stated). */
export function rupeeInputFromPaise(paise: number | null): string {
  if (paise === null || !Number.isSafeInteger(paise) || paise < 0) return '';
  const digits = String(paise).padStart(3, '0');
  const whole = digits.slice(0, -2);
  const fraction = digits.slice(-2);
  return fraction === '00' ? whole : `${whole}.${fraction}`;
}

/**
 * `"1,299"` / `"₹1299"` / `"1299.5"` → `129950`-style integer paise; null when
 * the text is not a parseable non-negative rupee amount. Two decimal places at
 * most — paise are the smallest unit there is.
 */
export function paiseFromRupeeInput(raw: string): number | null {
  const match = /^\s*₹?\s*([0-9][0-9,]*)(?:\.([0-9]{1,2}))?\s*$/.exec(raw);
  if (match === null) return null;
  const whole = match[1]!.replaceAll(',', '');
  const fraction = (match[2] ?? '').padEnd(2, '0');
  // Integer arithmetic on safe integers is exact; the guard rejects overflow.
  const paise = Number(whole) * 100 + Number(fraction === '' ? '0' : fraction);
  return Number.isSafeInteger(paise) ? paise : null;
}

export function displayPaise(value: unknown): PaiseDisplay {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return { paise: `${String(value)} paise`, rupees: null };
  }
  // CONTEXT.md bans floating point wherever money is computed, so ₹ comes from
  // the decimal string alone: pad to three digits, split before the last two.
  const digits = String(value).padStart(3, '0');
  return {
    paise: `${groupIndian(String(value))} paise`,
    rupees: `₹${groupIndian(digits.slice(0, -2))}.${digits.slice(-2)}`,
  };
}
