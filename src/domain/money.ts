/**
 * Money is integer paise, INR only (CONTEXT.md → Money).
 *
 * Nothing in this file may produce or accept a floating-point rupee amount:
 * amounts are constructed only through `paise()`, and formatting is one-way
 * (paise → display string, never back). Razorpay is itself paise-denominated,
 * so paise travel unconverted all the way to the gateway and there is no
 * rounding step anywhere for a bug to live in.
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

export function multiplyPaise(unitAmount: Paise, quantity: number): Paise {
  if (!Number.isSafeInteger(quantity) || quantity < 0) {
    throw new MoneyError(`Quantity must be a non-negative safe integer, got: ${String(quantity)}`);
  }
  return paise(unitAmount * quantity);
}

/**
 * Display only — for prose shown to a human or an LLM. Never feed the result
 * back into arithmetic. `Paise` is non-negative by construction, so there is no
 * sign to render.
 */
export function formatPaise(amount: Paise): string {
  const rupees = Math.trunc(amount / 100);
  const remainder = amount % 100;
  // Indian digit grouping: last 3 digits, then pairs (12,34,567).
  const digits = String(rupees);
  const head = digits.length > 3 ? digits.slice(0, -3) : '';
  const tail = digits.length > 3 ? digits.slice(-3) : digits;
  const grouped =
    head === '' ? tail : `${head.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${tail}`;
  return `₹${grouped}.${String(remainder).padStart(2, '0')}`;
}

/**
 * One money amount as it crosses the wire: the machine-readable paise, a
 * human/LLM-readable rendering, and the currency. Every view type that carries
 * an amount carries exactly this, so a reader never has to check whether *this*
 * particular payload spells it `pricePaise` or `amountPaise`.
 */
export interface MoneyView {
  readonly amountPaise: Paise;
  readonly amountDisplay: string;
  readonly currency: Currency;
}

export function moneyView(amountPaise: Paise): MoneyView {
  return { amountPaise, amountDisplay: formatPaise(amountPaise), currency: CURRENCY };
}
