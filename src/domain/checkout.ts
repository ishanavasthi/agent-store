import { and, eq } from 'drizzle-orm';
import type { StorefrontDeps } from '../deps.js';
import type { AgentRow, OrderStatus } from '../db/schema.js';
import { intentMandates, orderItems, orders, paymentMandates } from '../db/schema.js';
import { appendAuditEvent } from './auditLog.js';
import { findPublishedVariant, type VariantView } from './catalog.js';
import { newId, toGatewayReference } from './ids.js';
import {
  computePriceHash,
  hashMandate,
  signMandate,
  verifyMandateChain,
  verifyMandateSignature,
  type CartItem,
  type CartMandatePayload,
  type IntentMandatePayload,
  type PaymentMandatePayload,
} from './mandates.js';
import { requireCartMandate, requireMerchantSigningKey, type CartLineView } from './mandateFlow.js';
import { moneyView, paise, type MoneyView } from './money.js';
import { Refusal, type RefusalPayload } from './refusal.js';

/**
 * `submit_payment` — the money path, and the only one (DECISIONS.md 2026-08-26
 * "the mandate chain is the only purchase path"; T1's tokens-only checkout is
 * gone). Shape preserved from the walking skeleton: four ordered phases —
 *   1. resolve the Cart mandate being paid,
 *   2. compose and custodially sign the Payment mandate,
 *   3. **the trust gate** — verify the whole chain; a Refusal returns from
 *      here, before any Order exists and before the gateway is ever touched,
 *   4. create the domain Order, then the one gateway artifact.
 *
 * ADR-0003: every state change below commits in the same transaction as its
 * audit event, and the *attempt* at each external call is recorded before the
 * call is made — so a crash mid-flight leaves a trace rather than a silence.
 */

export interface SubmitPaymentRequest {
  /** The `cartHash` returned by create_cart. */
  readonly cartHash: string;
  /** Buyer-minted, scoped Agent×Merchant (DECISIONS 2026-08-23 idempotency). */
  readonly idempotencyKey: string;
}

export interface SubmitPaymentResult {
  readonly orderId: string;
  readonly status: OrderStatus;
  readonly total: MoneyView;
  readonly items: readonly CartLineView[];
  readonly gatewayPaymentLinkId: string;
  /** The hosted link the human approves — the consent step. */
  readonly paymentLinkUrl: string;
  readonly paymentMandate: {
    readonly paymentHash: string;
    readonly payload: PaymentMandatePayload;
    readonly signature: string;
  };
}

export async function submitPayment(
  deps: StorefrontDeps,
  agent: AgentRow,
  request: SubmitPaymentRequest,
): Promise<SubmitPaymentResult> {
  const { db, gateway, publicBaseUrl } = deps;
  const merchantId = agent.merchantId;

  // --- 1. Resolve the Cart mandate being paid ------------------------------
  // An unknown or foreign cartHash is a bad reference — a validation error,
  // never a Refusal (CONTEXT.md → Failure vocabulary).
  const cartRow = await requireCartMandate(db, agent, request.cartHash);
  const cart = cartRow.payload as CartMandatePayload;

  // --- 2. Compose and custodially sign the Payment mandate ------------------
  const paymentPayload: PaymentMandatePayload = {
    agentId: agent.id,
    merchantId,
    cartHash: cartRow.hash,
    idempotencyKey: request.idempotencyKey,
    createdAt: new Date().toISOString(),
  };
  const paymentHash = hashMandate(paymentPayload);
  const paymentSignature = signMandate(agent.privateKey, paymentPayload);

  // --- 3. Trust gate --------------------------------------------------------
  // Everything below runs strictly before the Order insert and before the
  // first gateway audit event, so a Refusal here means zero money moved and
  // the gateway was never contacted. Refusals are audited first (the
  // `agent.refused` precedent: own transaction, orderId null), then thrown.
  const refuse = async (payload: RefusalPayload): Promise<never> => {
    const refusal = new Refusal(payload);
    await db.transaction(async (tx) => {
      await appendAuditEvent(tx, {
        type: 'payment.refused',
        merchantId,
        orderId: null,
        payload: {
          code: refusal.code,
          reason: refusal.reason,
          recoverable: refusal.recoverable,
          cartHash: cartRow.hash,
          intentHash: cartRow.intentHash,
          tool: 'submit_payment',
        },
      });
    });
    throw refusal;
  };

  // The chain's root must exist and belong to the same Agent. The cart row was
  // only ever written pointing at a stored Intent, so a miss here is a broken
  // chain — policy, not a bad reference.
  const [intentRow] = await db
    .select()
    .from(intentMandates)
    .where(and(eq(intentMandates.hash, cartRow.intentHash), eq(intentMandates.merchantId, merchantId)))
    .limit(1);
  if (intentRow === undefined || intentRow.agentId !== agent.id) {
    return refuse({
      code: 'INVALID_MANDATE',
      reason: `Cart mandate ${cartRow.hash} points at no Intent mandate of this Agent's`,
      recoverable: false,
    });
  }
  const intent = intentRow.payload as IntentMandatePayload;

  const merchantKey = await requireMerchantSigningKey(db, merchantId);

  // Stored signatures verify against the live public keys, and the hashes bind
  // Intent → Cart → Payment with consistent totals. One changed byte anywhere
  // breaks this (src/domain/keys.ts's contract).
  const signaturesValid =
    verifyMandateSignature(agent.publicKey, intent, intentRow.agentSignature) &&
    verifyMandateSignature(agent.publicKey, cart, cartRow.agentSignature) &&
    verifyMandateSignature(merchantKey.publicKey, cart, cartRow.merchantSignature);
  const chain = verifyMandateChain(intent, cart, paymentPayload);
  if (!signaturesValid || !chain.ok) {
    return refuse({
      code: 'INVALID_MANDATE',
      reason: signaturesValid
        ? `Mandate chain failed verification: ${chain.failures.join(', ')}`
        : 'A stored mandate signature does not verify against its public key',
      recoverable: false,
    });
  }

  // Re-pin the price hash against the CURRENT catalog. A Variant that has
  // vanished from the published catalog since the Cart was signed cannot
  // confirm its pinned price either — same refusal, same recovery.
  const currentItems: Array<Pick<CartItem, 'variantId' | 'unitPricePaise'>> = [];
  const variantViews = new Map<string, VariantView>();
  for (const item of cart.items) {
    const variant = await findPublishedVariant(db, merchantId, item.variantId);
    if (variant === null) {
      return refuse({
        code: 'PRICE_CHANGED',
        reason: `Variant ${item.variantId} is no longer published at the price this Cart pinned. Call create_cart again against the current catalog.`,
        recoverable: true,
      });
    }
    currentItems.push({ variantId: variant.variantId, unitPricePaise: variant.price.amountPaise });
    variantViews.set(variant.variantId, variant);
  }
  if (computePriceHash(currentItems) !== cart.priceHash) {
    return refuse({
      code: 'PRICE_CHANGED',
      reason:
        'The catalog price of at least one item changed since this Cart was signed. ' +
        'Call create_cart again to get a Cart mandate at the current prices.',
      recoverable: true,
    });
  }

  // Stock covers every line — the pre-payment check (an Oversell is the
  // post-capture shortfall, found at fulfillment; don't mix the words).
  for (const item of cart.items) {
    const variant = variantViews.get(item.variantId)!;
    if (variant.stock < item.quantity) {
      return refuse({
        code: 'OUT_OF_STOCK',
        reason: `Only ${variant.stock} left of ${variant.productTitle}; ${item.quantity} requested`,
        recoverable: variant.stock > 0,
      });
    }
  }

  // T5's enforcement slot (issue #6) — the checks land here, after the chain
  // verifies and before any Order exists. Everything they need is already
  // persisted: OVER_BUDGET reads `intent_mandates.budget_paise`, OVER_CAP sums
  // paid Orders per Agent×Merchant via `orders.agent_id`, INTENT_CONSUMED
  // guards `intent_mandates.consumed_by_order_id` in SQL, IDEMPOTENCY_REUSE
  // rides the unique (agent_id, idempotency_key) index on payment_mandates.

  // --- 4. Create the domain Order -------------------------------------------
  const orderId = newId('order');
  const totalPaise = paise(cart.totalPaise);
  const total = moneyView(totalPaise);

  // Order, its line items, the Payment mandate row, and both audit events
  // commit together (ADR-0003). The legacy single-variant columns on `orders`
  // stay NULL — line items are `order_items` rows now (DECISIONS 2026-08-26).
  await db.transaction(async (tx) => {
    await tx.insert(orders).values({
      id: orderId,
      merchantId,
      agentId: agent.id,
      amountPaise: totalPaise,
      currency: total.currency,
      status: 'created',
    });
    await tx.insert(orderItems).values(
      cart.items.map((item) => ({
        id: newId('orderItem'),
        orderId,
        variantId: item.variantId,
        quantity: item.quantity,
        unitPricePaise: item.unitPricePaise,
      })),
    );
    await tx.insert(paymentMandates).values({
      id: newId('paymentMandate'),
      agentId: agent.id,
      merchantId,
      cartHash: cartRow.hash,
      idempotencyKey: request.idempotencyKey,
      payload: paymentPayload,
      hash: paymentHash,
      agentSignature: paymentSignature,
      orderId,
    });
    await appendAuditEvent(tx, {
      type: 'payment.verified',
      merchantId,
      orderId,
      payload: {
        agentId: agent.id,
        intentHash: intentRow.hash,
        cartHash: cartRow.hash,
        paymentHash,
        amountPaise: totalPaise,
      },
    });
    await appendAuditEvent(tx, {
      type: 'order.created',
      merchantId,
      orderId,
      payload: {
        agentId: agent.id,
        cartHash: cartRow.hash,
        items: cart.items.map((item) => ({ ...item })),
        amountPaise: totalPaise,
        currency: total.currency,
      },
    });
  });

  const reference = toGatewayReference(orderId);
  const description = cart.items
    .map((item) => {
      const variant = variantViews.get(item.variantId)!;
      const label = variant.label === null ? '' : ` (${variant.label})`;
      return `${variant.productTitle}${label} × ${item.quantity}`;
    })
    .join(', ');
  const callbackUrl = `${publicBaseUrl}/payment-callback?orderId=${encodeURIComponent(orderId)}`;

  // Recorded *before* the call. If the process dies mid-request, the chain
  // shows an attempt with no outcome — which is a fact, not a gap (ADR-0003).
  await db.transaction(async (tx) => {
    await appendAuditEvent(tx, {
      type: 'gateway.payment_link_attempted',
      merchantId,
      orderId,
      payload: {
        gateway: gateway.name,
        reference,
        amountPaise: totalPaise,
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
    amountPaise: totalPaise,
    currency: total.currency,
    description,
    callbackUrl,
    notes: { orderId, merchantId },
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
      merchantId,
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
    items: cart.items.map((item) => {
      const variant = variantViews.get(item.variantId)!;
      return {
        variantId: item.variantId,
        productTitle: variant.productTitle,
        label: variant.label,
        quantity: item.quantity,
        unitPrice: moneyView(paise(item.unitPricePaise)),
      };
    }),
    gatewayPaymentLinkId: paymentLink.gatewayPaymentLinkId,
    paymentLinkUrl: paymentLink.url,
    paymentMandate: {
      paymentHash,
      payload: paymentPayload,
      signature: paymentSignature,
    },
  };
}
