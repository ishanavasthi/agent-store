import { eq } from 'drizzle-orm';
import type { StorefrontDeps } from '../deps.js';
import type { OrderStatus } from '../db/schema.js';
import { orders } from '../db/schema.js';
import { appendAuditEvent } from './auditLog.js';
import { defaultPublishedVariant, findPublishedVariant, type VariantView } from './catalog.js';
import { newId, toGatewayReference } from './ids.js';
import { moneyView, multiplyPaise, type MoneyView } from './money.js';
import { Refusal, ValidationError } from './refusal.js';

/**
 * Checkout — the walking-skeleton path (T1).
 *
 * Shape to preserve: this reads as four ordered phases —
 *   1. validate the request,
 *   2. resolve what is being bought and refuse on policy,
 *   3. **the trust gate** (empty in T1),
 *   4. create the domain Order, then the one gateway artifact.
 *
 * T3/T4 insert mandate-chain verification, Budget/Cap enforcement, idempotency
 * and price-hash pinning at phase 3 — strictly *before* any call reaches the
 * gateway, so a Refusal always means zero money moved. That ordering is the
 * whole reason the gateway call lives at the bottom of this function rather
 * than interleaved with the Order write.
 *
 * ADR-0003: every state change below commits in the same transaction as its
 * audit event, and the *attempt* at each external call is recorded before the
 * call is made — so a crash mid-flight leaves a trace rather than a silence.
 */

export interface CheckoutRequest {
  readonly merchantId: string;
  /** Omitted means "the merchant's single published Variant" (T1 convenience). */
  readonly variantId?: string | undefined;
  readonly quantity: number;
}

export interface CheckoutResult {
  readonly orderId: string;
  readonly status: OrderStatus;
  readonly total: MoneyView;
  readonly quantity: number;
  readonly variant: VariantView;
  readonly gatewayPaymentLinkId: string;
  /** The hosted link the human approves — the consent step. */
  readonly paymentLinkUrl: string;
}

export async function checkout(
  deps: StorefrontDeps,
  request: CheckoutRequest,
): Promise<CheckoutResult> {
  const { db, gateway, publicBaseUrl } = deps;

  // --- 1. Validate the request --------------------------------------------
  // A malformed argument is a plain validation error — never a Refusal, which
  // is reserved for policy (CONTEXT.md → Failure vocabulary).
  if (!Number.isSafeInteger(request.quantity) || request.quantity < 1) {
    throw new ValidationError('INVALID_QUANTITY', 'Quantity must be a positive integer');
  }

  // --- 2. Resolve what is being bought ------------------------------------
  const variant =
    request.variantId === undefined
      ? await defaultPublishedVariant(db, request.merchantId)
      : await findPublishedVariant(db, request.merchantId, request.variantId);

  if (variant === null) {
    throw new ValidationError(
      'VARIANT_NOT_FOUND',
      request.variantId === undefined
        ? 'This merchant has no published Variant to sell'
        : `No published Variant with id ${request.variantId}`,
    );
  }

  if (variant.stock < request.quantity) {
    // A Refusal: policy says no, before money moves. CONTEXT.md names
    // out-of-stock as *the* pre-payment refusal case (as distinct from an
    // Oversell, which is a shortfall found after capture). Recoverable — the
    // Agent can buy fewer.
    throw new Refusal({
      code: 'OUT_OF_STOCK',
      reason: `Only ${variant.stock} left of ${variant.productTitle}; ${request.quantity} requested`,
      recoverable: variant.stock > 0,
    });
  }

  // --- 3. Trust gate -------------------------------------------------------
  // T3's identity gate runs even earlier: `requireRegisteredAgent` refuses
  // unregistered callers at the tool boundary (src/mcp/server.ts), before this
  // function is entered. T4 fills this phase: verify the mandate chain, enforce
  // Budget and Cap, check idempotency and the pinned price hash. A Refusal
  // returns from here, before the gateway is ever touched.

  // --- 4. Create the domain Order -----------------------------------------
  const orderId = newId('order');
  const total = moneyView(multiplyPaise(variant.price.amountPaise, request.quantity));

  await db.transaction(async (tx) => {
    await tx.insert(orders).values({
      id: orderId,
      merchantId: request.merchantId,
      variantId: variant.variantId,
      quantity: request.quantity,
      unitPricePaise: variant.price.amountPaise,
      amountPaise: total.amountPaise,
      currency: total.currency,
      status: 'created',
    });
    await appendAuditEvent(tx, {
      type: 'order.created',
      merchantId: request.merchantId,
      orderId,
      payload: {
        variantId: variant.variantId,
        productTitle: variant.productTitle,
        quantity: request.quantity,
        unitPricePaise: variant.price.amountPaise,
        amountPaise: total.amountPaise,
        currency: total.currency,
      },
    });
  });

  const reference = toGatewayReference(orderId);
  const description = `${variant.productTitle}${variant.label === null ? '' : ` (${variant.label})`} × ${request.quantity}`;
  const callbackUrl = `${publicBaseUrl}/payment-callback?orderId=${encodeURIComponent(orderId)}`;

  // Recorded *before* the call. If the process dies mid-request, the chain
  // shows an attempt with no outcome — which is a fact, not a gap (ADR-0003).
  await db.transaction(async (tx) => {
    await appendAuditEvent(tx, {
      type: 'gateway.payment_link_attempted',
      merchantId: request.merchantId,
      orderId,
      payload: {
        gateway: gateway.name,
        reference,
        amountPaise: total.amountPaise,
        currency: total.currency,
        callbackUrl,
      },
    });
  });

  // The Payment Link is the only gateway object created at checkout: Razorpay
  // mints its own gateway order behind it, and that id is learned from the
  // webhook rather than invented here.
  const paymentLink = await gateway.createPaymentLink({
    reference,
    amountPaise: total.amountPaise,
    currency: total.currency,
    description,
    callbackUrl,
    notes: { orderId, merchantId: request.merchantId },
  });

  const status: OrderStatus = 'awaiting_payment';

  await db.transaction(async (tx) => {
    await tx
      .update(orders)
      .set({
        gatewayPaymentLinkId: paymentLink.gatewayPaymentLinkId,
        paymentLinkUrl: paymentLink.url,
        status,
        updatedAt: new Date(),
      })
      .where(eq(orders.id, orderId));
    await appendAuditEvent(tx, {
      type: 'gateway.payment_link_issued',
      merchantId: request.merchantId,
      orderId,
      payload: {
        gateway: gateway.name,
        gatewayPaymentLinkId: paymentLink.gatewayPaymentLinkId,
        paymentLinkUrl: paymentLink.url,
        amountPaise: paymentLink.amountPaise,
        gatewayStatus: paymentLink.status,
        // A hint only — the webhook's value is authoritative and is recorded
        // separately as `gateway.order_linked`.
        hintedGatewayOrderId: paymentLink.gatewayOrderId,
      },
    });
  });

  return {
    orderId,
    status,
    total,
    quantity: request.quantity,
    variant,
    gatewayPaymentLinkId: paymentLink.gatewayPaymentLinkId,
    paymentLinkUrl: paymentLink.url,
  };
}
