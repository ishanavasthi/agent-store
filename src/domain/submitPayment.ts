import { and, eq, isNull, notInArray, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import type { StorefrontDeps } from '../deps.js';
import type { AgentRow, OrderStatus, PaymentMandateRow } from '../db/schema.js';
import {
  intentMandates,
  orderItems,
  orders,
  paymentMandates,
  products,
  variants,
} from '../db/schema.js';
import { appendAuditEvent } from './auditLog.js';
import { findPublishedVariant, type VariantView } from './catalog.js';
import { newId, toGatewayReference } from './ids.js';
import {
  computePriceHash,
  hashMandate,
  parseCartMandatePayload,
  parseIntentMandatePayload,
  parsePaymentMandatePayload,
  signMandate,
  verifyMandateChain,
  verifyMandateSignature,
  type CartItem,
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
 *   3. **the trust gate** — verify the whole chain and enforce policy (issue
 *      #6: idempotency, Budget, Cap, intent consumption); a Refusal returns
 *      from here with nothing persisted and the gateway never touched, and a
 *      same-key retry returns the original result from here instead of
 *      charging twice,
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
  const cart = parseCartMandatePayload(cartRow.payload);

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
  // A Refusal from anywhere in this gate means zero rows persisted and the
  // gateway never contacted: the pre-transaction checks run strictly before
  // the Order insert, and the in-transaction checks (OVER_CAP, intent
  // consumption) roll the whole transaction back before this helper runs.
  // In particular a refused submission persists no payment_mandates row, so a
  // refusal never consumes an idempotency key. Refusals are audited first
  // (the `agent.refused` precedent: own transaction, orderId null), then
  // thrown.
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

  // The rule for a key that already carries a Payment mandate (DECISIONS
  // 2026-08-23 idempotency): same cart hash replays the original result —
  // no new Order, no gateway call, no second charge — and a different cart
  // hash refuses rather than silently answering for a cart the buyer never
  // submitted. Reached from the lookup below and from the unique-index race
  // backstop after the transaction.
  const replayOrRefuse = async (existing: PaymentMandateRow): Promise<SubmitPaymentResult> => {
    if (existing.cartHash !== cartRow.hash) {
      return refuse({
        code: 'IDEMPOTENCY_REUSE',
        reason:
          `Idempotency key ${request.idempotencyKey} already belongs to a Payment mandate for a ` +
          `different cart (${existing.cartHash}). Mint a fresh key for this cart.`,
        recoverable: true,
      });
    }
    return replayOriginalResult(db, agent, existing);
  };

  // Idempotency is checked before the rest of the gate: a retry of a passed
  // payment must replay even if the catalog has since moved (PRICE_CHANGED and
  // every later check would answer for the *new* submission, not the one the
  // buyer already made). Keys are buyer-minted and scoped Agent×Merchant.
  const [existingMandate] = await db
    .select()
    .from(paymentMandates)
    .where(
      and(
        eq(paymentMandates.agentId, agent.id),
        eq(paymentMandates.idempotencyKey, request.idempotencyKey),
      ),
    )
    .limit(1);
  if (existingMandate !== undefined) {
    return replayOrRefuse(existingMandate);
  }

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
  const intent = parseIntentMandatePayload(intentRow.payload);

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

  // The paid chain is 1:1:1 (DECISIONS 2026-08-23): an Intent is consumed by
  // its first paid Cart mandate. Friendly pre-check only — the race-proof
  // guard is the SQL UPDATE inside the order transaction below.
  if (intentRow.consumedByOrderId !== null) {
    return refuse({
      code: 'INTENT_CONSUMED',
      reason:
        `Intent ${intentRow.hash} was already consumed by order ${intentRow.consumedByOrderId}. ` +
        'Declare a new Intent for this purchase — a second purchase signs a new Intent.',
      recoverable: true,
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

  // Budget (per Intent) is enforced against the *signed* Intent payload, not
  // the denormalized `budget_paise` column — the artifact is what the Agent
  // authorized. Recoverable: a smaller cart under this same Intent can pass —
  // contrast OVER_CAP below.
  if (cart.totalPaise > intent.budgetPaise) {
    return refuse({
      code: 'OVER_BUDGET',
      reason:
        `Cart total ${moneyView(cart.totalPaise).amountDisplay} exceeds this Intent's Budget of ` +
        `${moneyView(intent.budgetPaise).amountDisplay}. Create a smaller cart under this Intent, ` +
        'or declare a new Intent with a larger Budget.',
      recoverable: true,
    });
  }

  // --- 4. Create the domain Order -------------------------------------------
  const orderId = newId('order');
  // Already branded: parseCartMandatePayload re-asserted every Paise field.
  const totalPaise = cart.totalPaise;
  const total = moneyView(totalPaise);

  // Order, its line items, the Payment mandate row, and both audit events
  // commit together (ADR-0003). The legacy single-variant columns on `orders`
  // stay NULL — line items are `order_items` rows now (DECISIONS 2026-08-26).
  //
  // The last two policy checks live INSIDE this transaction (issue #6:
  // "checked in a transaction"): OVER_CAP over a sum that cannot go stale
  // against the Order it gates, and intent consumption under its SQL guard.
  // Either one throws a Refusal, rolling back every insert — so a refused
  // submission persists nothing, and in particular no payment_mandates row.
  try {
    await db.transaction(async (tx) => {
      // Cap (per Agent×Merchant, and an Agent belongs to exactly one
      // merchant) counts captured AND pending spend: created /
      // awaiting_payment / paid all hold money against the ceiling; only
      // cancelled/refunded free headroom. Not recoverable: the Cap is
      // immutable for the registration's lifetime (ADR-0001), and
      // cancellation/refund is not something the Agent can perform.
      const [cumulative] = await tx
        .select({ spent: sql<string>`coalesce(sum(${orders.amountPaise}), 0)` })
        .from(orders)
        .where(
          and(eq(orders.agentId, agent.id), notInArray(orders.status, ['cancelled', 'refunded'])),
        );
      const spentPaise = paise(Number(cumulative?.spent ?? 0));
      if (spentPaise + totalPaise > agent.capPaise) {
        throw new Refusal({
          code: 'OVER_CAP',
          reason:
            `This cart's ${moneyView(totalPaise).amountDisplay} on top of ` +
            `${moneyView(spentPaise).amountDisplay} already spent or pending would exceed this ` +
            `registration's Cap of ${moneyView(paise(agent.capPaise)).amountDisplay}. ` +
            "The Cap is immutable for this registration's lifetime.",
          recoverable: false,
        });
      }

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
      // Intent consumption, the house exactly-once pattern: the guard lives
      // in the SQL, not in a read-then-write. Zero rows means another
      // submission consumed this Intent after the pre-check above — the race
      // path of INTENT_CONSUMED.
      const consumed = await tx
        .update(intentMandates)
        .set({ consumedByOrderId: orderId })
        .where(
          and(eq(intentMandates.hash, intentRow.hash), isNull(intentMandates.consumedByOrderId)),
        )
        .returning({ id: intentMandates.id });
      if (consumed.length === 0) {
        throw new Refusal({
          code: 'INTENT_CONSUMED',
          reason:
            `Intent ${intentRow.hash} was consumed by a concurrent submission. ` +
            'Declare a new Intent for this purchase — a second purchase signs a new Intent.',
          recoverable: true,
        });
      }
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
  } catch (error) {
    // The transaction is fully rolled back before either branch below runs,
    // so the refusal-audit transaction never nests inside it.
    if (error instanceof Refusal) {
      return refuse(error.toPayload());
    }
    // The unique (agent_id, idempotency_key) index is the idempotency race
    // backstop: two first-time submissions with one key can both miss the
    // gate's lookup, and the loser lands here. Structured behavior — replay
    // or IDEMPOTENCY_REUSE against the winning row — never a raw index error
    // surfacing to the buyer.
    if (isIdempotencyKeyConflict(error)) {
      const [winner] = await db
        .select()
        .from(paymentMandates)
        .where(
          and(
            eq(paymentMandates.agentId, agent.id),
            eq(paymentMandates.idempotencyKey, request.idempotencyKey),
          ),
        )
        .limit(1);
      if (winner !== undefined) {
        return replayOrRefuse(winner);
      }
    }
    throw error;
  }

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
        unitPrice: moneyView(item.unitPricePaise),
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

/**
 * Rebuild the original SubmitPaymentResult from what the passed submission
 * persisted: the Order row, its `order_items` joined to variants/products for
 * titles and labels (history, not catalog — a Variant unpublished since then
 * still renders), and the stored Payment mandate row. Audits
 * `payment.replayed` against the original Order; no new rows, no gateway
 * contact.
 */
async function replayOriginalResult(
  db: Database,
  agent: AgentRow,
  existing: PaymentMandateRow,
): Promise<SubmitPaymentResult> {
  // Rows are written only by this codebase; re-parsing re-brands the Paise
  // fields and fails loudly on out-of-band mutation.
  const payload = parsePaymentMandatePayload(existing.payload);
  const [orderRow] =
    existing.orderId === null
      ? []
      : await db.select().from(orders).where(eq(orders.id, existing.orderId)).limit(1);
  if (orderRow === undefined) {
    throw new Error(
      `Payment mandate ${existing.hash} names no Order to replay; the store was mutated out-of-band`,
    );
  }
  // Crash window: the original submission died between the Order insert and
  // the payment link issuance, so there is no result to replay. Resuming a
  // half-finished checkout is not replay's job — fail loudly rather than
  // contact the gateway under a key that promises no second call.
  if (orderRow.gatewayPaymentLinkId === null || orderRow.paymentLinkUrl === null) {
    throw new Error(
      `Order ${orderRow.id} has no payment link; the original submission never completed, so its result cannot be replayed`,
    );
  }
  const gatewayPaymentLinkId = orderRow.gatewayPaymentLinkId;
  const paymentLinkUrl = orderRow.paymentLinkUrl;

  const lines = await db
    .select({
      variantId: orderItems.variantId,
      quantity: orderItems.quantity,
      unitPricePaise: orderItems.unitPricePaise,
      productTitle: products.title,
      label: variants.label,
    })
    .from(orderItems)
    .innerJoin(variants, eq(orderItems.variantId, variants.id))
    .innerJoin(products, eq(variants.productId, products.id))
    .where(eq(orderItems.orderId, orderRow.id))
    .orderBy(orderItems.variantId);

  // Own transaction, original Order: a replay is a real event on that
  // purchase's chain, not a state change (ADR-0003's atomicity rule binds
  // events to state changes; here there is none).
  await db.transaction(async (tx) => {
    await appendAuditEvent(tx, {
      type: 'payment.replayed',
      merchantId: orderRow.merchantId,
      orderId: orderRow.id,
      payload: {
        agentId: agent.id,
        idempotencyKey: existing.idempotencyKey,
        cartHash: existing.cartHash,
        paymentHash: existing.hash,
        orderId: orderRow.id,
      },
    });
  });

  return {
    orderId: orderRow.id,
    status: orderRow.status,
    total: moneyView(paise(orderRow.amountPaise)),
    items: lines.map((line) => ({
      variantId: line.variantId,
      productTitle: line.productTitle,
      label: line.label,
      quantity: line.quantity,
      unitPrice: moneyView(paise(line.unitPricePaise)),
    })),
    gatewayPaymentLinkId,
    paymentLinkUrl,
    paymentMandate: {
      paymentHash: existing.hash,
      payload,
      signature: existing.agentSignature,
    },
  };
}

/**
 * A Postgres unique violation (23505) on `payment_mandates_agent_idempotency_idx`,
 * however the driver wrapped it — drizzle surfaces the pg error as the `cause`
 * of a DrizzleQueryError, and the constraint name rides on the pg error (or,
 * failing that, in its message).
 */
function isIdempotencyKeyConflict(error: unknown): boolean {
  for (let cause: unknown = error; cause instanceof Error; cause = cause.cause) {
    const pgError = cause as { readonly code?: unknown; readonly constraint?: unknown };
    if (pgError.code === '23505') {
      return typeof pgError.constraint === 'string'
        ? pgError.constraint === 'payment_mandates_agent_idempotency_idx'
        : cause.message.includes('payment_mandates_agent_idempotency_idx');
    }
  }
  return false;
}
