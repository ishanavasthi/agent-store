import { createHmac, timingSafeEqual } from 'node:crypto';
import { isPaise, type Paise } from '../domain/money.js';
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
 * Which Razorpay events mean "money moved".
 *
 * These are *Razorpay's* names. Note `order.paid`: we have an audit event
 * spelled identically, which is exactly why raw names are namespaced before
 * they are written anywhere (see `namespaceGatewayEvent`).
 *
 * A Payment Link purchase fires more than one of these, and Razorpay redelivers
 * on any non-2xx, so the handler above must be idempotent.
 */
const SUCCESS_EVENTS = new Set(['payment_link.paid', 'payment.captured', 'order.paid']);
const FAILURE_EVENTS = new Set(['payment.failed']);

export function classifyRazorpayEvent(rawEvent: string): GatewayWebhookKind {
  if (SUCCESS_EVENTS.has(rawEvent)) return 'payment_succeeded';
  if (FAILURE_EVENTS.has(rawEvent)) return 'payment_failed';
  return 'other';
}

export class WebhookParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookParseError';
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function entity(
  payload: Record<string, unknown> | null,
  key: string,
): Record<string, unknown> | null {
  const slot = asRecord(payload?.[key]);
  return asRecord(slot?.['entity']);
}

function str(source: Record<string, unknown> | null, key: string): string | null {
  const value = source?.[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Read a paise amount, or throw.
 *
 * An absent amount is `null` — legitimate for events that carry none. An amount
 * that is *present but not a valid paise value* is a `WebhookParseError`, never
 * a `MoneyError`: the caller answers a signed-but-unparseable body 200/ignored,
 * whereas an escaping error would 5xx and make Razorpay redeliver it forever.
 */
function amount(source: Record<string, unknown> | null, key: string): Paise | null {
  const value = source?.[key];
  if (value === undefined || value === null) return null;
  if (!isPaise(value)) {
    throw new WebhookParseError(
      `Webhook amount is not a non-negative integer number of paise: ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/**
 * Normalise a Razorpay webhook body into a gateway-neutral event.
 *
 * The domain Order id is recovered from whichever field carried it out: the
 * Payment Link's `reference_id`, the gateway order's `receipt`, or the `notes`
 * map we set at creation. All three originate from us, so any one arriving is
 * enough — and none of them is a guess.
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
    asRecord(payment?.['notes']) ??
    asRecord(gatewayOrder?.['notes']) ??
    asRecord(paymentLink?.['notes']);

  const reference =
    str(paymentLink, 'reference_id') ?? str(notes, 'orderId') ?? str(gatewayOrder, 'receipt');

  return {
    kind: classifyRazorpayEvent(rawEvent),
    rawEvent,
    reference,
    gatewayOrderId:
      str(gatewayOrder, 'id') ?? str(payment, 'order_id') ?? str(paymentLink, 'order_id'),
    gatewayPaymentId: str(payment, 'id'),
    gatewayPaymentLinkId: str(paymentLink, 'id'),
    amountPaise:
      amount(payment, 'amount') ?? amount(paymentLink, 'amount') ?? amount(gatewayOrder, 'amount'),
    // Razorpay puts the failure detail on the payment entity (`error_code`,
    // `error_description`). Read leniently: a failure without them is still a
    // failure, just an unexplained one.
    gatewayErrorCode: str(payment, 'error_code'),
    gatewayErrorDescription: str(payment, 'error_description'),
  };
}
