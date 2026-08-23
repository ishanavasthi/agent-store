import type { Paise } from '../domain/money.js';

/**
 * The payment-gateway seam (PLAN §5.4, spec "Injected seam #1").
 *
 * Two implementations are planned and only one exists today:
 *   - `RazorpayGateway` (this ticket) — the real Razorpay Node SDK, test mode.
 *   - the deterministic in-process stub (T2) — mints gateway orders and links,
 *     fires synthetic webhook events, and simulates Declines and Oversells on
 *     demand so the scripted eval suite is CI-runnable.
 *
 * Everything the stub will need is therefore expressed here as data, never as
 * "call Razorpay": creating objects, verifying a webhook signature, and parsing
 * a webhook body into a gateway-neutral event. Nothing above this interface may
 * import the `razorpay` package.
 *
 * Naming: Razorpay's identifiers are `gateway*` throughout (CONTEXT.md →
 * Gateway order). A bare `orderId` in this codebase always means our domain
 * Order.
 */

export interface CreateGatewayOrderParams {
  /** Our domain Order id, carried to the gateway as its `reference_id`. */
  readonly reference: string;
  readonly amountPaise: Paise;
  readonly currency: 'INR';
  /** Small string map echoed back on webhook payloads. */
  readonly notes: Readonly<Record<string, string>>;
}

export interface GatewayOrder {
  readonly gatewayOrderId: string;
  readonly amountPaise: Paise;
  readonly currency: string;
  readonly status: string;
}

export interface CreatePaymentLinkParams {
  readonly reference: string;
  readonly amountPaise: Paise;
  readonly currency: 'INR';
  readonly description: string;
  /** Where Razorpay sends the human's browser after they approve. */
  readonly callbackUrl: string;
  readonly notes: Readonly<Record<string, string>>;
}

export interface PaymentLink {
  readonly gatewayPaymentLinkId: string;
  /** The hosted URL handed to the human — this *is* the consent step. */
  readonly url: string;
  readonly amountPaise: Paise;
  readonly status: string;
}

/**
 * A gateway webhook, normalised. The raw provider event name is kept so the
 * audit log records exactly what arrived, while `kind` is what code branches on.
 */
export type GatewayWebhookKind = 'payment_succeeded' | 'payment_failed' | 'other';

export interface GatewayWebhookEvent {
  readonly kind: GatewayWebhookKind;
  /** Provider's own event name, e.g. `payment_link.paid`. */
  readonly rawEvent: string;
  /** Our domain Order id, recovered from the gateway object's reference. */
  readonly reference: string | null;
  readonly gatewayOrderId: string | null;
  readonly gatewayPaymentId: string | null;
  readonly gatewayPaymentLinkId: string | null;
  readonly amountPaise: Paise | null;
}

export class GatewayError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'GatewayError';
  }
}

/** Thrown when a webhook body fails signature verification. Never a Refusal. */
export class WebhookSignatureError extends Error {
  constructor(message = 'Webhook signature verification failed') {
    super(message);
    this.name = 'WebhookSignatureError';
  }
}

export interface PaymentGateway {
  /** Identifies the implementation in audit payloads: `razorpay` | `stub`. */
  readonly name: string;

  createGatewayOrder(params: CreateGatewayOrderParams): Promise<GatewayOrder>;

  createPaymentLink(params: CreatePaymentLinkParams): Promise<PaymentLink>;

  /**
   * Constant-time verification over the *raw* request body. The caller must
   * pass the exact bytes received — re-serialising parsed JSON changes them.
   */
  verifyWebhookSignature(rawBody: string, signature: string): boolean;

  /** Pure: raw body → normalised event. Throws on a body it cannot understand. */
  parseWebhookEvent(rawBody: string): GatewayWebhookEvent;
}
