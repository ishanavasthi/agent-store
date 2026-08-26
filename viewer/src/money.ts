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
export function displayPaise(value: unknown): PaiseDisplay {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return { paise: `${String(value)} paise`, rupees: null };
  }
  const rupees = Math.trunc(value / 100);
  const remainder = value % 100;
  return {
    paise: `${groupIndian(String(value))} paise`,
    rupees: `₹${groupIndian(String(rupees))}.${String(remainder).padStart(2, '0')}`,
  };
}
