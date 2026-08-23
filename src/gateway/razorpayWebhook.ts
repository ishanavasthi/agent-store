import { createHmac, timingSafeEqual } from 'node:crypto';
import { paise, type Paise } from '../domain/money.js';
import type { GatewayWebhookEvent, GatewayWebhookKind } from './types.js';

/**
 * Pure webhook helpers — no SDK, no network, no clock.
 *
 * Kept apart from `RazorpayGateway` so signature verification and payload
 * parsing are unit-testable without credentials, and so T2's stub can reuse the
 * same normalisation when it fires synthetic events.
 */

export const RAZORPAY_SIGNATURE_HEADER = 'x-razorpay-signature';

/**
 * `HMAC-SHA256(rawBody, webhookSecret)`, hex, compared in constant time.
 *
 * `rawBody` must be the exact bytes Razorpay sent. Re-serialising parsed JSON
 * changes key order and whitespace, and the signature will never match.
 */
export function verifyRazorpaySignature(
  rawBody: string,
  signature: string,
  webhookSecret: string,
): boolean {
  if (signature === '') return false;
  const expected = createHmac('sha256', webhookSecret).update(rawBody, 'utf8').digest('hex');
  const given = Buffer.from(signature, 'utf8');
  const want = Buffer.from(expected, 'utf8');
  // timingSafeEqual throws on a length mismatch, which is itself a leak-free "no".
  if (given.length !== want.length) return false;
  return timingSafeEqual(given, want);
}

/**
 * Which Razorpay events mean "money moved". `payment.captured` and
 * `payment_link.paid` both arrive for a Payment Link purchase, so the handler
 * must be idempotent (Razorpay also redelivers on non-2xx).
 */
const SUCCESS_EVENTS = new Set(['payment_link.paid', 'payment.captured', 'order.paid']);
const FAILURE_EVENTS = new Set(['payment.failed']);

export function classifyRazorpayEvent(rawEvent: string): GatewayWebhookKind {
  if (SUCCESS_EVENTS.has(rawEvent)) return 'payment_succeeded';
  if (FAILURE_EVENTS.has(rawEvent)) return 'payment_failed';
  return 'other';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function entity(payload: Record<string, unknown> | null, key: string): Record<string, unknown> | null {
  const slot = asRecord(payload?.[key]);
  return asRecord(slot?.['entity']);
}

function str(source: Record<string, unknown> | null, key: string): string | null {
  const value = source?.[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function amount(source: Record<string, unknown> | null, key: string): Paise | null {
  const value = source?.[key];
  return typeof value === 'number' ? paise(value) : null;
}

export class WebhookParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookParseError';
  }
}

/**
 * Normalise a Razorpay webhook body into a gateway-neutral event.
 *
 * The domain Order id is recovered from whichever field carried it out: the
 * Payment Link's `reference_id`, the gateway order's `receipt`, or the `notes`
 * map we set at creation. All three are set by `RazorpayGateway`, so any one of
 * them arriving is enough.
 */
export function parseRazorpayWebhook(rawBody: string): GatewayWebhookEvent {
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch (error) {
    throw new WebhookParseError(`Webhook body is not JSON: ${String(error)}`);
  }

  const root = asRecord(body);
  const rawEvent = str(root, 'event');
  if (rawEvent === null) {
    throw new WebhookParseError('Webhook body has no `event` field');
  }

  const payload = asRecord(root?.['payload']);
  const paymentLink = entity(payload, 'payment_link');
  const payment = entity(payload, 'payment');
  const gatewayOrder = entity(payload, 'order');

  const notes =
    asRecord(payment?.['notes']) ?? asRecord(gatewayOrder?.['notes']) ?? asRecord(paymentLink?.['notes']);

  const reference =
    str(paymentLink, 'reference_id') ?? str(gatewayOrder, 'receipt') ?? str(notes, 'orderId');

  return {
    kind: classifyRazorpayEvent(rawEvent),
    rawEvent,
    reference,
    gatewayOrderId:
      str(gatewayOrder, 'id') ?? str(payment, 'order_id') ?? str(paymentLink, 'order_id'),
    gatewayPaymentId: str(payment, 'id'),
    gatewayPaymentLinkId: str(paymentLink, 'id'),
    amountPaise: amount(payment, 'amount') ?? amount(paymentLink, 'amount') ?? amount(gatewayOrder, 'amount'),
  };
}
