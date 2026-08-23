/**
 * Money is integer paise, INR only (CONTEXT.md → Money).
 *
 * Nothing in this file may produce or accept a floating-point rupee amount:
 * formatting is one-way (paise → display string) and parsing is explicit and
 * fallible. Razorpay is itself paise-denominated, so paise travel unconverted
 * all the way to the gateway.
 */

export const CURRENCY = 'INR' as const;
export type Currency = typeof CURRENCY;

/** Branded so a bare `number` can't drift in as "rupees" by accident. */
export type Paise = number & { readonly __brand: 'Paise' };

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

export function isPaise(value: unknown): value is Paise {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Assert an untrusted number really is a non-negative integer paise amount. */
export function paise(value: number): Paise {
  if (!isPaise(value)) {
    throw new MoneyError(
      `Amount must be a non-negative safe integer number of paise, got: ${String(value)}`,
    );
  }
  return value;
}

/** Sum of line amounts. Integer-only, so no rounding step exists to get wrong. */
export function sumPaise(amounts: readonly Paise[]): Paise {
  let total = 0;
  for (const amount of amounts) total += amount;
  return paise(total);
}

export function multiplyPaise(unitAmount: Paise, quantity: number): Paise {
  if (!Number.isSafeInteger(quantity) || quantity < 0) {
    throw new MoneyError(`Quantity must be a non-negative safe integer, got: ${String(quantity)}`);
  }
  return paise(unitAmount * quantity);
}

/**
 * Display only — for prose shown to a human or an LLM. Never feed the result
 * back into arithmetic.
 */
export function formatPaise(amount: Paise): string {
  const sign = amount < 0 ? '-' : '';
  const abs = Math.abs(amount);
  const rupees = Math.trunc(abs / 100);
  const remainder = abs % 100;
  // Indian digit grouping: last 3 digits, then pairs (12,34,567).
  const digits = String(rupees);
  const head = digits.length > 3 ? digits.slice(0, -3) : '';
  const tail = digits.length > 3 ? digits.slice(-3) : digits;
  const groupedHead = head.replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  const grouped = head === '' ? tail : `${groupedHead},${tail}`;
  return `${sign}₹${grouped}.${String(remainder).padStart(2, '0')}`;
}

/**
 * Parse a decimal rupee string ("499", "499.00", "1,299.50") into paise.
 * String-based on purpose: `Number("0.07") * 100` is 7.000000000000001.
 */
export function parseRupeesToPaise(input: string): Paise {
  const cleaned = input.trim().replace(/[₹,\s]/g, '');
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) {
    throw new MoneyError(`Not a rupee amount: ${JSON.stringify(input)}`);
  }
  const rupees = Number.parseInt(match[1] as string, 10);
  const fraction = (match[2] ?? '').padEnd(2, '0');
  return paise(rupees * 100 + Number.parseInt(fraction, 10));
}
