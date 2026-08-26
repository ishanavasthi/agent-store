import type { Currency, Paise } from '../domain/money.js';

/**
 * The payment-gateway seam (PLAN §5.4, spec "Injected seam #1").
 *
 * Two implementations:
 *   - `RazorpayGateway` (T1) — the real Razorpay Node SDK, test mode.
 *   - `StubGateway` (T2) — deterministic and in-process: mints Payment Links,
 *     returns synthetic webhook events for the harness to deliver, and
 *     simulates Declines and Oversells on demand so the scripted eval suite
 *     is CI-runnable.
 *
 * Everything the stub will need is therefore expressed here as data, never as
 * "call Razorpay": creating a link, verifying a webhook signature, and parsing
 * a webhook body into a gateway-neutral event. Nothing above this interface may
 * import the `razorpay` package.
 *
 * **There is deliberately no `createGatewayOrder`.** A Razorpay Payment Link
 * mints its *own* internal gateway order; creating one ourselves produced an
 * object no payment would ever hit, whose id then contradicted the real one
 * arriving on the webhook. The Payment Link is the only checkout-time gateway
 * artifact, and the gateway order id is *learned* from the webhook.
 *
 * Naming: Razorpay's identifiers are `gateway*` throughout (CONTEXT.md →
 * Gateway order). A bare `orderId` in this codebase always means our domain
 * Order.
 */

export interface CreatePaymentLinkParams {
  /** Our domain Order id, carried to the gateway as its `reference_id`. */
  readonly reference: string;
  readonly amountPaise: Paise;
  readonly currency: Currency;
  readonly description: string;
  /** Where Razorpay sends the human's browser after they approve. */
  readonly callbackUrl: string;
  /** Small string map echoed back on webhook payloads. */
  readonly notes: Readonly<Record<string, string>>;
}

export interface PaymentLink {
  readonly gatewayPaymentLinkId: string;
  /** The hosted URL handed to the human — this *is* the consent step. */
  readonly url: string;
  readonly amountPaise: Paise;
  readonly status: string;
  /**
   * The gateway order the link minted, when the create response exposes it.
   * Treated as a hint only: the authoritative value is whatever the webhook
   * reports, because that is the object the payment actually hit.
   */
  readonly gatewayOrderId: string | null;
}

/**
 * A gateway webhook, normalised. The provider's own event name is kept so the
 * audit log records exactly what arrived, while `kind` is what code branches on.
 */
export type GatewayWebhookKind = 'payment_succeeded' | 'payment_failed' | 'other';

export interface GatewayWebhookEvent {
  readonly kind: GatewayWebhookKind;
  /**
   * The provider's own event name, unqualified (e.g. `payment_link.paid`).
   * Namespace it with `namespaceGatewayEvent` before writing it anywhere the
   * rule-auditor reads — Razorpay has an `order.paid` and so do we.
   */
  readonly rawEvent: string;
  /** Our domain Order id, recovered from a reference field we ourselves set. */
  readonly reference: string | null;
  readonly gatewayOrderId: string | null;
  readonly gatewayPaymentId: string | null;
  readonly gatewayPaymentLinkId: string | null;
  readonly amountPaise: Paise | null;
  /**
   * The gateway's own error code/description on a `payment_failed` event —
   * the raw material of a structured Decline (T8). Null on success events and
   * on failures the gateway did not explain.
   */
  readonly gatewayErrorCode: string | null;
  readonly gatewayErrorDescription: string | null;
}

/**
 * A refund against one captured gateway payment (T9, PLAN §5.2/§5.5). Amounts
 * are integer paise, unconverted, exactly as everywhere else. Test-mode trap
 * §5.5: refunds only work against **captured** payments — an Oversell always
 * satisfies that, because the Oversell path begins at a capture.
 */
export interface RefundPaymentParams {
  /** The captured payment being reversed (`pay_…`). */
  readonly gatewayPaymentId: string;
  readonly amountPaise: Paise;
  /** Small string map stored on the gateway refund for the operator's benefit. */
  readonly notes: Readonly<Record<string, string>>;
}

export interface GatewayRefund {
  /** The gateway's own refund object id (`rfnd_…`) — bound into the refund receipt. */
  readonly gatewayRefundId: string;
  readonly amountPaise: Paise;
  readonly status: string;
}

export class GatewayError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'GatewayError';
  }
}

export interface PaymentGateway {
  /** Identifies the implementation in audit payloads: `razorpay` | `stub`. */
  readonly name: string;

  createPaymentLink(params: CreatePaymentLinkParams): Promise<PaymentLink>;

  /**
   * Constant-time verification over the *raw* request body. The caller must
   * pass the exact bytes received — re-serialising parsed JSON changes them.
   */
  verifyWebhookSignature(rawBody: string, signature: string): boolean;

  /**
   * Pure: raw body → normalised event. Throws `WebhookParseError` on anything
   * it cannot make sense of, including a malformed amount — callers answer such
   * a body 200/ignored rather than 5xx, so the gateway stops redelivering it.
   */
  parseWebhookEvent(rawBody: string): GatewayWebhookEvent;

  /**
   * Refund a captured payment (the Oversell path, T9). Throws `GatewayError`
   * when the gateway will not refund — unknown payment, not captured, already
   * fully refunded — and the caller records that as an anomaly rather than
   * retrying blind: a refund is money moving, never fire-and-forget.
   */
  refundPayment(params: RefundPaymentParams): Promise<GatewayRefund>;
}
