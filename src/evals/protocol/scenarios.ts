import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { LocalSigner } from '../../buyer/localSigner.js';
import {
  hashMandate,
  parseCartMandatePayload,
  parseReceiptPayload,
  parseRefundReceiptPayload,
  verifyMandateSignature,
  type CartMandatePayload,
} from '../../domain/mandates.js';
import { paise } from '../../domain/money.js';
import type { FaceCallResult, FaceDriver, SubmitPaymentArgs } from './faces.js';
import { ScenarioFailure, type Face, type ScenarioCategory } from './types.js';
import {
  CAP_VARIANT,
  TEE_PRICE_PAISE,
  TEE_VARIANT,
  type ScenarioWorld,
} from './world.js';

/**
 * The 30 scripted protocol scenarios (T15, issue #16; PLAN §6). Every scenario
 * is written against the `FaceDriver` seam, so the same steps run through the
 * MCP tools or the ACP-flavored REST endpoints — 18 drive MCP, 10 drive REST,
 * and 2 deliberately drive both faces in one scenario (the Refusal-parity and
 * Oversell cross-face checks). Everything a scenario asserts is read off the
 * wire or delivered through the real webhook route; nothing reaches into
 * server internals. The only non-wire touches are `setVariantPrice` /
 * `setVariantStock` — the *merchant's* half of the price-change and restock
 * stories, which no buyer-facing protocol can perform.
 *
 * De-scope note (PLAN §9 rung 6): if the ladder ever fires, this list shrinks
 * 30 → 15 by keeping the first scenario of each pair-like group; the
 * rule-auditor is not part of this file and never dies.
 */

export interface Scenario {
  readonly id: string;
  readonly name: string;
  readonly face: Face;
  readonly category: ScenarioCategory;
  /** The outcome the scenario demands, stated for the report. */
  readonly expected: string;
  run(world: ScenarioWorld): Promise<void>;
}

// ---------------------------------------------------------------------------
// Assertion helpers — every failure carries a reason, verbatim in the report.
// ---------------------------------------------------------------------------

function check(condition: boolean, reason: string): asserts condition {
  if (!condition) throw new ScenarioFailure(reason);
}

function expectOk(result: FaceCallResult, context: string): Record<string, unknown> {
  check(
    result.ok,
    `${context}: expected success, got ${JSON.stringify(result.body).slice(0, 300)}`,
  );
  return result.body;
}

function expectRefusal(
  result: FaceCallResult,
  code: string,
  context: string,
): Record<string, unknown> {
  check(!result.ok, `${context}: expected a ${code} Refusal, but the call succeeded`);
  check(
    result.refusal !== null,
    `${context}: expected a ${code} Refusal, got ${JSON.stringify(result.body).slice(0, 300)}`,
  );
  check(
    result.refusal['code'] === code,
    `${context}: expected Refusal code ${code}, got ${String(result.refusal['code'])}`,
  );
  check(
    typeof result.refusal['reason'] === 'string' && result.refusal['reason'] !== '',
    `${context}: Refusal ${code} carries no reason`,
  );
  check(
    typeof result.refusal['recoverable'] === 'boolean',
    `${context}: Refusal ${code} carries no boolean recoverable`,
  );
  return result.refusal;
}

function expectValidationError(result: FaceCallResult, code: string, context: string): void {
  check(!result.ok, `${context}: expected a ${code} validation error, but the call succeeded`);
  check(
    result.validationError !== null,
    `${context}: expected a ${code} validation error, got ${JSON.stringify(result.body).slice(0, 300)}`,
  );
  check(
    result.validationError['code'] === code,
    `${context}: expected validation error ${code}, got ${String(result.validationError['code'])}`,
  );
  check(
    result.refusal === null,
    `${context}: a validation error must never also read as a Refusal`,
  );
}

function str(body: Record<string, unknown>, key: string, context: string): string {
  const value = body[key];
  check(typeof value === 'string' && value !== '', `${context}: missing string ${key}`);
  return value;
}

// ---------------------------------------------------------------------------
// Flow helpers — the custodial chain, timing, and the consent step.
// ---------------------------------------------------------------------------

async function registerBuyer(
  driver: FaceDriver,
  capPaise: number,
  publicKey?: string,
): Promise<{ token: string; agentId: string; merchantId: string }> {
  const body = expectOk(
    await driver.registerAgent(publicKey === undefined ? { capPaise } : { capPaise, publicKey }),
    'register_agent',
  );
  return {
    token: str(body, 'agentToken', 'register_agent'),
    agentId: str(body, 'agentId', 'register_agent'),
    merchantId: str(body, 'merchantId', 'register_agent'),
  };
}

async function buildCart(
  driver: FaceDriver,
  token: string,
  input: {
    want: string;
    budgetPaise: number;
    items: ReadonlyArray<{ variantId: string; quantity: number }>;
  },
): Promise<{ intentHash: string; cartHash: string; cartBody: Record<string, unknown> }> {
  const intent = expectOk(
    await driver.declareIntent({
      agentToken: token,
      want: input.want,
      budgetPaise: input.budgetPaise,
    }),
    'declare_intent',
  );
  const intentHash = str(intent, 'intentHash', 'declare_intent');
  const cartBody = expectOk(
    await driver.createCart({ agentToken: token, intentHash, items: input.items }),
    'create_cart',
  );
  return { intentHash, cartHash: str(cartBody, 'cartHash', 'create_cart'), cartBody };
}

/** submit_payment, timed; a successful checkout's latency lands in the run. */
async function timedSubmit(
  world: ScenarioWorld,
  driver: FaceDriver,
  args: SubmitPaymentArgs,
): Promise<FaceCallResult> {
  const startedAt = performance.now();
  const result = await driver.submitPayment(args);
  if (result.ok) world.recordCheckoutLatency(performance.now() - startedAt);
  return result;
}

/** The consent step, scripted: settle the link and deliver both webhooks. */
async function payOrder(world: ScenarioWorld, submitBody: Record<string, unknown>): Promise<void> {
  const linkId = str(submitBody, 'gatewayPaymentLinkId', 'submit_payment');
  await world.deliver(world.gateway.completePayment(linkId));
}

/** Poll-free confirmation: webhooks were delivered synchronously above. */
async function expectPaidWithReceipt(
  driver: FaceDriver,
  token: string,
  orderId: string,
  expectedAmountPaise: number,
): Promise<void> {
  const status = expectOk(
    await driver.getOrderStatus({ agentToken: token, orderId }),
    'get_order_status',
  );
  check(status['status'] === 'paid', `Order ${orderId}: expected paid, got ${String(status['status'])}`);
  const receipt = status['receipt'] as Record<string, unknown> | null;
  check(receipt !== null && receipt !== undefined, `paid Order ${orderId} carries no Receipt`);
  const payload = parseReceiptPayload(receipt['payload']);
  const signature = str(receipt, 'signature', 'receipt');
  const merchantPublicKey = str(receipt, 'merchantPublicKey', 'receipt');
  check(
    verifyMandateSignature(merchantPublicKey, payload, signature),
    `the Receipt for ${orderId} fails independent Ed25519 verification`,
  );
  check(
    payload.orderId === orderId && payload.amountPaise === expectedAmountPaise,
    `the Receipt for ${orderId} attests the wrong order or amount`,
  );
}

/** register → intent → cart → submit → pay → paid, on one face. */
async function happyPurchase(
  world: ScenarioWorld,
  face: 'mcp' | 'rest',
  items: ReadonlyArray<{ variantId: string; quantity: number }>,
  expectedTotalPaise: number,
): Promise<void> {
  const driver = world.driver(face);
  const catalog = expectOk(await driver.getProduct(), 'get_product');
  const variants = catalog['variants'];
  check(Array.isArray(variants) && variants.length === 2, 'catalog shows the two seeded Variants');

  const { token } = await registerBuyer(driver, 500000);
  const { cartHash, cartBody } = await buildCart(driver, token, {
    want: 'streetwear, within budget',
    budgetPaise: 400000,
    items,
  });
  const total = cartBody['total'] as Record<string, unknown>;
  check(
    total['amountPaise'] === expectedTotalPaise,
    `cart total ${String(total['amountPaise'])} ≠ expected ${expectedTotalPaise}`,
  );

  const submit = expectOk(
    await timedSubmit(world, driver, { agentToken: token, cartHash, idempotencyKey: randomUUID() }),
    'submit_payment',
  );
  check(submit['status'] === 'awaiting_payment', 'Order awaits the human consent step');
  const orderId = str(submit, 'orderId', 'submit_payment');
  await payOrder(world, submit);
  await expectPaidWithReceipt(driver, token, orderId, expectedTotalPaise);
}

// ---------------------------------------------------------------------------
// The scenarios.
// ---------------------------------------------------------------------------

export const PROTOCOL_SCENARIOS: readonly Scenario[] = [
  // --- Happy path ----------------------------------------------------------
  {
    id: 'happy-purchase-mcp',
    name: 'Happy purchase over MCP: full mandate chain to a verified Receipt',
    face: 'mcp',
    category: 'happy path',
    expected: 'Order paid; merchant-signed Receipt verifies independently',
    run: (world) => happyPurchase(world, 'mcp', [{ variantId: TEE_VARIANT, quantity: 1 }], 129900),
  },
  {
    id: 'happy-purchase-rest',
    name: 'Happy purchase over REST: same chain, same Receipt, the ACP door',
    face: 'rest',
    category: 'happy path',
    expected: 'Order paid; merchant-signed Receipt verifies independently',
    run: (world) => happyPurchase(world, 'rest', [{ variantId: TEE_VARIANT, quantity: 1 }], 129900),
  },
  {
    id: 'happy-multi-item-mcp',
    name: 'Multi-item Cart mandate: two tees and a cap in one immutable cart',
    face: 'mcp',
    category: 'happy path',
    expected: 'Cart totals 3097.00 in integer paise; Order paid with Receipt',
    run: (world) =>
      happyPurchase(
        world,
        'mcp',
        [
          { variantId: TEE_VARIANT, quantity: 2 },
          { variantId: CAP_VARIANT, quantity: 1 },
        ],
        2 * 129900 + 49900,
      ),
  },
  {
    id: 'happy-client-custody-mcp',
    name: 'Client-custody purchase: the buyer signs every mandate locally',
    face: 'mcp',
    category: 'happy path',
    expected: 'Server never holds the key; locally signed chain reaches paid + Receipt',
    async run(world) {
      const driver = world.driver('mcp');
      const signer = new LocalSigner();
      const { token, agentId, merchantId } = await registerBuyer(driver, 500000, signer.publicKey);

      const intent = signer.composeIntent({
        agentId,
        merchantId,
        want: 'one tee, self-signed',
        budgetPaise: 200000,
      });
      const declared = expectOk(
        await driver.declareIntent({
          agentToken: token,
          want: intent.payload.want,
          budgetPaise: intent.payload.budgetPaise,
          createdAt: intent.payload.createdAt,
          signature: intent.signature,
        }),
        'declare_intent (client custody)',
      );
      check(
        declared['intentHash'] === intent.hash,
        'server intentHash must equal the locally computed hash',
      );

      const cartBody = expectOk(
        await driver.createCart({
          agentToken: token,
          intentHash: intent.hash,
          items: [{ variantId: TEE_VARIANT, quantity: 1 }],
        }),
        'create_cart (client custody)',
      );
      check(
        cartBody['agentSignature'] === null,
        'the server must not sign the Cart for a client-custody Agent',
      );
      const cartPayload = parseCartMandatePayload(cartBody['payload']);
      const cart = signer.signCart(cartPayload);
      const payment = signer.composePayment({
        agentId,
        merchantId,
        cartHash: cart.hash,
        idempotencyKey: randomUUID(),
      });
      const submit = expectOk(
        await timedSubmit(world, driver, {
          agentToken: token,
          cartHash: cart.hash,
          idempotencyKey: payment.payload.idempotencyKey,
          cartSignature: cart.signature,
          paymentCreatedAt: payment.payload.createdAt,
          paymentSignature: payment.signature,
        }),
        'submit_payment (client custody)',
      );
      const orderId = str(submit, 'orderId', 'submit_payment');
      await payOrder(world, submit);
      await expectPaidWithReceipt(driver, token, orderId, 129900);
    },
  },

  // --- Refusals ------------------------------------------------------------
  {
    id: 'unregistered-agent-mcp',
    name: 'Unregistered agent over MCP: a commerce call with a bogus token',
    face: 'mcp',
    category: 'refusals',
    expected: 'UNREGISTERED_AGENT Refusal; no mandate ever declared',
    async run(world) {
      const driver = world.driver('mcp');
      expectRefusal(
        await driver.declareIntent({
          agentToken: 'agt_tok_never_minted',
          want: 'anything',
          budgetPaise: 100000,
        }),
        'UNREGISTERED_AGENT',
        'declare_intent with a bogus token',
      );
    },
  },
  {
    id: 'unregistered-agent-rest',
    name: 'Unregistered agent over REST: bogus bearer token on /acp/intents',
    face: 'rest',
    category: 'refusals',
    expected: 'UNREGISTERED_AGENT Refusal, identical shape to the MCP face',
    async run(world) {
      const driver = world.driver('rest');
      expectRefusal(
        await driver.declareIntent({
          agentToken: 'agt_tok_never_minted',
          want: 'anything',
          budgetPaise: 100000,
        }),
        'UNREGISTERED_AGENT',
        'POST /acp/intents with a bogus bearer',
      );
    },
  },
  {
    id: 'over-budget-mcp',
    name: 'Over-Budget over MCP: the cart exceeds the Intent it chains to',
    face: 'mcp',
    category: 'refusals',
    expected: 'OVER_BUDGET Refusal at submit_payment, recoverable',
    async run(world) {
      const driver = world.driver('mcp');
      const { token } = await registerBuyer(driver, 500000);
      const { cartHash } = await buildCart(driver, token, {
        want: 'a tee on a tight budget',
        budgetPaise: 100000, // < the tee's 129900
        items: [{ variantId: TEE_VARIANT, quantity: 1 }],
      });
      const refusal = expectRefusal(
        await driver.submitPayment({ agentToken: token, cartHash, idempotencyKey: randomUUID() }),
        'OVER_BUDGET',
        'submit_payment above Budget',
      );
      check(refusal['recoverable'] === true, 'OVER_BUDGET must be recoverable (smaller cart passes)');
    },
  },
  {
    id: 'over-budget-rest',
    name: 'Over-Budget over REST: same Refusal through the ACP door',
    face: 'rest',
    category: 'refusals',
    expected: 'OVER_BUDGET Refusal at POST /acp/payments, recoverable',
    async run(world) {
      const driver = world.driver('rest');
      const { token } = await registerBuyer(driver, 500000);
      const { cartHash } = await buildCart(driver, token, {
        want: 'a tee on a tight budget',
        budgetPaise: 100000,
        items: [{ variantId: TEE_VARIANT, quantity: 1 }],
      });
      expectRefusal(
        await driver.submitPayment({ agentToken: token, cartHash, idempotencyKey: randomUUID() }),
        'OVER_BUDGET',
        'POST /acp/payments above Budget',
      );
    },
  },
  {
    id: 'over-cap-mcp',
    name: 'Over-Cap over MCP: a second purchase would breach the registration Cap',
    face: 'mcp',
    category: 'refusals',
    expected: 'First purchase paid; second refuses OVER_CAP, not recoverable',
    async run(world) {
      const driver = world.driver('mcp');
      const { token } = await registerBuyer(driver, 150000); // fits one tee, never tee+cap
      const first = await buildCart(driver, token, {
        want: 'a tee',
        budgetPaise: 200000,
        items: [{ variantId: TEE_VARIANT, quantity: 1 }],
      });
      const submit = expectOk(
        await timedSubmit(world, driver, {
          agentToken: token,
          cartHash: first.cartHash,
          idempotencyKey: randomUUID(),
        }),
        'first submit_payment',
      );
      await payOrder(world, submit);

      const second = await buildCart(driver, token, {
        want: 'now a cap as well',
        budgetPaise: 60000,
        items: [{ variantId: CAP_VARIANT, quantity: 1 }],
      });
      const refusal = expectRefusal(
        await driver.submitPayment({
          agentToken: token,
          cartHash: second.cartHash,
          idempotencyKey: randomUUID(),
        }),
        'OVER_CAP',
        'second purchase above the Cap',
      );
      check(refusal['recoverable'] === false, 'OVER_CAP is not recoverable — the Cap is immutable');
    },
  },
  {
    id: 'over-cap-rest',
    name: 'Over-Cap over REST: a single cart bigger than the declared Cap',
    face: 'rest',
    category: 'refusals',
    expected: 'OVER_CAP Refusal before any gateway contact',
    async run(world) {
      const driver = world.driver('rest');
      const { token } = await registerBuyer(driver, 100000); // < the tee's 129900
      const { cartHash } = await buildCart(driver, token, {
        want: 'a tee above my cap',
        budgetPaise: 200000, // Budget passes; the Cap is what refuses
        items: [{ variantId: TEE_VARIANT, quantity: 1 }],
      });
      expectRefusal(
        await driver.submitPayment({ agentToken: token, cartHash, idempotencyKey: randomUUID() }),
        'OVER_CAP',
        'POST /acp/payments above the Cap',
      );
    },
  },
  {
    id: 'out-of-stock-mid-cart-mcp',
    name: 'Out of stock mid-cart: a rival buys the shelf between cart and payment',
    face: 'mcp',
    category: 'refusals',
    expected: 'OUT_OF_STOCK Refusal at submit_payment — nothing was reserved',
    async run(world) {
      const buyer = world.driver('mcp');
      const { token } = await registerBuyer(buyer, 500000);
      const { cartHash } = await buildCart(buyer, token, {
        want: 'two tees',
        budgetPaise: 400000,
        items: [{ variantId: TEE_VARIANT, quantity: 2 }],
      });

      // The rival buys 4 of the 5 seeded tees and PAYS — fulfilment
      // decrements the shelf to 1, under the first buyer's still-valid cart.
      const rival = world.driver('mcp');
      const rivalReg = await registerBuyer(rival, 600000);
      const rivalCart = await buildCart(rival, rivalReg.token, {
        want: 'four tees, quickly',
        budgetPaise: 600000,
        items: [{ variantId: TEE_VARIANT, quantity: 4 }],
      });
      const rivalSubmit = expectOk(
        await timedSubmit(world, rival, {
          agentToken: rivalReg.token,
          cartHash: rivalCart.cartHash,
          idempotencyKey: randomUUID(),
        }),
        'rival submit_payment',
      );
      await payOrder(world, rivalSubmit);

      const refusal = expectRefusal(
        await buyer.submitPayment({ agentToken: token, cartHash, idempotencyKey: randomUUID() }),
        'OUT_OF_STOCK',
        'submit_payment after the rival emptied the shelf',
      );
      check(refusal['recoverable'] === true, 'one tee remains, so the Refusal is recoverable');
    },
  },
  {
    id: 'price-change-mcp',
    name: 'Price change between cart and payment, then recovery at the new price',
    face: 'mcp',
    category: 'refusals',
    expected: 'PRICE_CHANGED Refusal; re-running create_cart recovers',
    async run(world) {
      const driver = world.driver('mcp');
      const { token } = await registerBuyer(driver, 500000);
      const stale = await buildCart(driver, token, {
        want: 'a tee at the launch price',
        budgetPaise: 200000,
        items: [{ variantId: TEE_VARIANT, quantity: 1 }],
      });

      await world.setVariantPrice(TEE_VARIANT, TEE_PRICE_PAISE + 10000); // the merchant repriced

      const refusal = expectRefusal(
        await driver.submitPayment({
          agentToken: token,
          cartHash: stale.cartHash,
          idempotencyKey: randomUUID(),
        }),
        'PRICE_CHANGED',
        'submit_payment against the stale pinned price',
      );
      check(refusal['recoverable'] === true, 'PRICE_CHANGED must be recoverable');

      // The recovery the Refusal names: a fresh cart at the current price.
      const fresh = expectOk(
        await driver.createCart({
          agentToken: token,
          intentHash: stale.intentHash,
          items: [{ variantId: TEE_VARIANT, quantity: 1 }],
        }),
        'create_cart after the reprice',
      );
      const total = fresh['total'] as Record<string, unknown>;
      check(total['amountPaise'] === TEE_PRICE_PAISE + 10000, 'the fresh cart pins the new price');
      expectOk(
        await timedSubmit(world, driver, {
          agentToken: token,
          cartHash: str(fresh, 'cartHash', 'create_cart'),
          idempotencyKey: randomUUID(),
        }),
        'submit_payment at the current price',
      );
    },
  },
  {
    id: 'price-change-rest',
    name: 'Price change over REST: the pinned price hash fails closed',
    face: 'rest',
    category: 'refusals',
    expected: 'PRICE_CHANGED Refusal at POST /acp/payments',
    async run(world) {
      const driver = world.driver('rest');
      const { token } = await registerBuyer(driver, 500000);
      const { cartHash } = await buildCart(driver, token, {
        want: 'a tee at the old price',
        budgetPaise: 200000,
        items: [{ variantId: TEE_VARIANT, quantity: 1 }],
      });
      await world.setVariantPrice(TEE_VARIANT, TEE_PRICE_PAISE - 5000);
      expectRefusal(
        await driver.submitPayment({ agentToken: token, cartHash, idempotencyKey: randomUUID() }),
        'PRICE_CHANGED',
        'POST /acp/payments against the stale pinned price',
      );
    },
  },
  {
    id: 'intent-consumed-mcp',
    name: 'Second purchase on a consumed Intent over MCP (the chain is 1:1:1)',
    face: 'mcp',
    category: 'refusals',
    expected: 'INTENT_CONSUMED Refusal for the second cart under one Intent',
    async run(world) {
      const driver = world.driver('mcp');
      const { token } = await registerBuyer(driver, 500000);
      const first = await buildCart(driver, token, {
        want: 'a tee, maybe a cap later',
        budgetPaise: 400000,
        items: [{ variantId: TEE_VARIANT, quantity: 1 }],
      });
      expectOk(
        await timedSubmit(world, driver, {
          agentToken: token,
          cartHash: first.cartHash,
          idempotencyKey: randomUUID(),
        }),
        'first submit_payment',
      );
      // A second cart under the SAME Intent — coexists freely (ADR-0002)…
      const second = expectOk(
        await driver.createCart({
          agentToken: token,
          intentHash: first.intentHash,
          items: [{ variantId: CAP_VARIANT, quantity: 1 }],
        }),
        'second create_cart under the same Intent',
      );
      // …but paying it is a second purchase on a consumed Intent.
      const refusal = expectRefusal(
        await driver.submitPayment({
          agentToken: token,
          cartHash: str(second, 'cartHash', 'create_cart'),
          idempotencyKey: randomUUID(),
        }),
        'INTENT_CONSUMED',
        'second submit_payment under one Intent',
      );
      check(refusal['recoverable'] === true, 'a new Intent recovers, so INTENT_CONSUMED is recoverable');
    },
  },
  {
    id: 'intent-consumed-rest',
    name: 'Second purchase on a consumed Intent over REST',
    face: 'rest',
    category: 'refusals',
    expected: 'INTENT_CONSUMED Refusal through the ACP door',
    async run(world) {
      const driver = world.driver('rest');
      const { token } = await registerBuyer(driver, 500000);
      const first = await buildCart(driver, token, {
        want: 'a tee now',
        budgetPaise: 400000,
        items: [{ variantId: TEE_VARIANT, quantity: 1 }],
      });
      expectOk(
        await timedSubmit(world, driver, {
          agentToken: token,
          cartHash: first.cartHash,
          idempotencyKey: randomUUID(),
        }),
        'first POST /acp/payments',
      );
      const second = expectOk(
        await driver.createCart({
          agentToken: token,
          intentHash: first.intentHash,
          items: [{ variantId: CAP_VARIANT, quantity: 1 }],
        }),
        'second POST /acp/carts under the same Intent',
      );
      expectRefusal(
        await driver.submitPayment({
          agentToken: token,
          cartHash: str(second, 'cartHash', 'create_cart'),
          idempotencyKey: randomUUID(),
        }),
        'INTENT_CONSUMED',
        'second POST /acp/payments under one Intent',
      );
    },
  },
  {
    id: 'refusal-parity-both-faces',
    name: 'Refusal parity: the same policy no is byte-identical on both faces',
    face: 'both',
    category: 'refusals',
    expected: 'OVER_BUDGET Refusal payloads deep-equal across MCP and REST',
    async run(world) {
      const refusals: Record<string, unknown>[] = [];
      for (const face of ['mcp', 'rest'] as const) {
        const driver = world.driver(face);
        const { token } = await registerBuyer(driver, 500000);
        const { cartHash } = await buildCart(driver, token, {
          want: 'a tee on a tight budget',
          budgetPaise: 100000,
          items: [{ variantId: TEE_VARIANT, quantity: 1 }],
        });
        refusals.push(
          expectRefusal(
            await driver.submitPayment({ agentToken: token, cartHash, idempotencyKey: randomUUID() }),
            'OVER_BUDGET',
            `submit via ${face}`,
          ),
        );
      }
      check(
        JSON.stringify(refusals[0]) === JSON.stringify(refusals[1]),
        `Refusal bodies differ across faces: ${JSON.stringify(refusals[0])} vs ${JSON.stringify(refusals[1])}`,
      );
    },
  },

  // --- Idempotency & replay ------------------------------------------------
  {
    id: 'replay-same-cart-mcp',
    name: 'Replayed Payment mandate over MCP: same key, same cart, one charge',
    face: 'mcp',
    category: 'idempotency & replay',
    expected: 'Retry returns the original Order and link; exactly one payment',
    async run(world) {
      const driver = world.driver('mcp');
      const { token } = await registerBuyer(driver, 500000);
      const { cartHash } = await buildCart(driver, token, {
        want: 'a tee, retried',
        budgetPaise: 200000,
        items: [{ variantId: TEE_VARIANT, quantity: 1 }],
      });
      const idempotencyKey = randomUUID();
      const first = expectOk(
        await timedSubmit(world, driver, { agentToken: token, cartHash, idempotencyKey }),
        'first submit_payment',
      );
      const retry = expectOk(
        await driver.submitPayment({ agentToken: token, cartHash, idempotencyKey }),
        'retried submit_payment',
      );
      check(retry['orderId'] === first['orderId'], 'the retry must replay the original Order');
      check(
        retry['gatewayPaymentLinkId'] === first['gatewayPaymentLinkId'],
        'the retry must return the original payment link — no second gateway artifact',
      );
      await payOrder(world, first);
      await expectPaidWithReceipt(driver, token, str(first, 'orderId', 'submit'), 129900);
      // A post-payment replay still answers for the one charge that happened.
      const late = expectOk(
        await driver.submitPayment({ agentToken: token, cartHash, idempotencyKey }),
        'post-payment replay',
      );
      check(late['orderId'] === first['orderId'], 'the post-payment replay names the same Order');
    },
  },
  {
    id: 'replay-same-cart-rest',
    name: 'Replayed Payment mandate over REST: the Idempotency-Key header honored',
    face: 'rest',
    category: 'idempotency & replay',
    expected: 'Retry replays the original result; no second charge',
    async run(world) {
      const driver = world.driver('rest');
      const { token } = await registerBuyer(driver, 500000);
      const { cartHash } = await buildCart(driver, token, {
        want: 'a cap, retried',
        budgetPaise: 100000,
        items: [{ variantId: CAP_VARIANT, quantity: 1 }],
      });
      const idempotencyKey = randomUUID();
      const first = expectOk(
        await timedSubmit(world, driver, { agentToken: token, cartHash, idempotencyKey }),
        'first POST /acp/payments',
      );
      const retry = expectOk(
        await driver.submitPayment({ agentToken: token, cartHash, idempotencyKey }),
        'retried POST /acp/payments',
      );
      check(retry['orderId'] === first['orderId'], 'the retry must replay the original Order');
      check(
        retry['gatewayPaymentLinkId'] === first['gatewayPaymentLinkId'],
        'the retry must return the original payment link',
      );
    },
  },
  {
    id: 'idempotency-reuse-mcp',
    name: 'Reused idempotency key with a different cart over MCP',
    face: 'mcp',
    category: 'idempotency & replay',
    expected: 'IDEMPOTENCY_REUSE Refusal — never answers for a cart the buyer did not submit',
    async run(world) {
      const driver = world.driver('mcp');
      const { token } = await registerBuyer(driver, 500000);
      const first = await buildCart(driver, token, {
        want: 'a tee',
        budgetPaise: 200000,
        items: [{ variantId: TEE_VARIANT, quantity: 1 }],
      });
      const idempotencyKey = randomUUID();
      expectOk(
        await timedSubmit(world, driver, { agentToken: token, cartHash: first.cartHash, idempotencyKey }),
        'first submit_payment',
      );
      const second = await buildCart(driver, token, {
        want: 'actually, a cap',
        budgetPaise: 100000,
        items: [{ variantId: CAP_VARIANT, quantity: 1 }],
      });
      const refusal = expectRefusal(
        await driver.submitPayment({ agentToken: token, cartHash: second.cartHash, idempotencyKey }),
        'IDEMPOTENCY_REUSE',
        'the same key against a different cart',
      );
      check(refusal['recoverable'] === true, 'minting a fresh key recovers');
    },
  },
  {
    id: 'idempotency-reuse-rest',
    name: 'Reused idempotency key with a different cart over REST',
    face: 'rest',
    category: 'idempotency & replay',
    expected: 'IDEMPOTENCY_REUSE Refusal through the ACP door',
    async run(world) {
      const driver = world.driver('rest');
      const { token } = await registerBuyer(driver, 500000);
      const first = await buildCart(driver, token, {
        want: 'a tee',
        budgetPaise: 200000,
        items: [{ variantId: TEE_VARIANT, quantity: 1 }],
      });
      const idempotencyKey = randomUUID();
      expectOk(
        await timedSubmit(world, driver, { agentToken: token, cartHash: first.cartHash, idempotencyKey }),
        'first POST /acp/payments',
      );
      const second = await buildCart(driver, token, {
        want: 'actually, a cap',
        budgetPaise: 100000,
        items: [{ variantId: CAP_VARIANT, quantity: 1 }],
      });
      expectRefusal(
        await driver.submitPayment({ agentToken: token, cartHash: second.cartHash, idempotencyKey }),
        'IDEMPOTENCY_REUSE',
        'the same Idempotency-Key against a different cart',
      );
    },
  },

  // --- Invalid mandates ----------------------------------------------------
  {
    id: 'malformed-intent-signature-mcp',
    name: 'Malformed mandate over MCP: an Intent signature over different bytes',
    face: 'mcp',
    category: 'invalid mandates',
    expected: 'INVALID_MANDATE Refusal before the mandate is stored',
    async run(world) {
      const driver = world.driver('mcp');
      const signer = new LocalSigner();
      const { token, agentId, merchantId } = await registerBuyer(driver, 500000, signer.publicKey);
      const intent = signer.composeIntent({
        agentId,
        merchantId,
        want: 'a tee',
        budgetPaise: 111111,
      });
      const refusal = expectRefusal(
        await driver.declareIntent({
          agentToken: token,
          want: intent.payload.want,
          budgetPaise: 222222, // not what the signature covers
          createdAt: intent.payload.createdAt,
          signature: intent.signature,
        }),
        'INVALID_MANDATE',
        'declare_intent with a signature over different bytes',
      );
      check(refusal['recoverable'] === false, 'that exact mandate can never become valid');
    },
  },
  {
    id: 'tampered-cart-signature-mcp',
    name: 'Tampered Cart mandate: the agent signs a cart with an altered total',
    face: 'mcp',
    category: 'invalid mandates',
    expected: 'INVALID_MANDATE Refusal at the trust gate; zero rows persisted',
    async run(world) {
      const driver = world.driver('mcp');
      const signer = new LocalSigner();
      const { token, agentId, merchantId } = await registerBuyer(driver, 500000, signer.publicKey);
      const intent = signer.composeIntent({
        agentId,
        merchantId,
        want: 'a tee',
        budgetPaise: 200000,
      });
      expectOk(
        await driver.declareIntent({
          agentToken: token,
          want: intent.payload.want,
          budgetPaise: intent.payload.budgetPaise,
          createdAt: intent.payload.createdAt,
          signature: intent.signature,
        }),
        'declare_intent',
      );
      const cartBody = expectOk(
        await driver.createCart({
          agentToken: token,
          intentHash: intent.hash,
          items: [{ variantId: TEE_VARIANT, quantity: 1 }],
        }),
        'create_cart',
      );
      const cartPayload = parseCartMandatePayload(cartBody['payload']);
      // The tamper: sign a cart whose total claims one paisa less.
      const tampered: CartMandatePayload = { ...cartPayload, totalPaise: paise(cartPayload.totalPaise - 1) };
      const forged = signer.signCart(tampered);
      const payment = signer.composePayment({
        agentId,
        merchantId,
        cartHash: str(cartBody, 'cartHash', 'create_cart'),
        idempotencyKey: randomUUID(),
      });
      expectRefusal(
        await driver.submitPayment({
          agentToken: token,
          cartHash: str(cartBody, 'cartHash', 'create_cart'),
          idempotencyKey: payment.payload.idempotencyKey,
          cartSignature: forged.signature, // does not verify over the real cart
          paymentCreatedAt: payment.payload.createdAt,
          paymentSignature: payment.signature,
        }),
        'INVALID_MANDATE',
        'submit_payment with a signature over a tampered cart',
      );
    },
  },
  {
    id: 'malformed-intent-signature-rest',
    name: 'Malformed mandate over REST: same forged Intent through the ACP door',
    face: 'rest',
    category: 'invalid mandates',
    expected: 'INVALID_MANDATE Refusal, identical shape to the MCP face',
    async run(world) {
      const driver = world.driver('rest');
      const signer = new LocalSigner();
      const { token, agentId, merchantId } = await registerBuyer(driver, 500000, signer.publicKey);
      const intent = signer.composeIntent({
        agentId,
        merchantId,
        want: 'a tee',
        budgetPaise: 111111,
      });
      expectRefusal(
        await driver.declareIntent({
          agentToken: token,
          want: intent.payload.want,
          budgetPaise: 222222,
          createdAt: intent.payload.createdAt,
          signature: intent.signature,
        }),
        'INVALID_MANDATE',
        'POST /acp/intents with a signature over different bytes',
      );
    },
  },
  {
    id: 'unknown-cart-hash-mcp',
    name: 'Payment against a cart hash that names nothing',
    face: 'mcp',
    category: 'invalid mandates',
    expected: 'CART_NOT_FOUND validation error — a bad reference, never a Refusal',
    async run(world) {
      const driver = world.driver('mcp');
      const { token } = await registerBuyer(driver, 500000);
      expectValidationError(
        await driver.submitPayment({
          agentToken: token,
          cartHash: 'f'.repeat(64),
          idempotencyKey: randomUUID(),
        }),
        'CART_NOT_FOUND',
        'submit_payment against an unknown cartHash',
      );
    },
  },

  // --- Validation errors ---------------------------------------------------
  {
    id: 'ambiguous-query-mcp',
    name: 'Ambiguous query: the want never resolves to a sellable Variant',
    face: 'mcp',
    category: 'validation errors',
    expected: 'VARIANT_NOT_FOUND validation error at create_cart',
    async run(world) {
      const driver = world.driver('mcp');
      const { token } = await registerBuyer(driver, 500000);
      const intent = expectOk(
        await driver.declareIntent({
          agentToken: token,
          want: 'that thing from the reel, you know the one',
          budgetPaise: 200000,
        }),
        'declare_intent',
      );
      expectValidationError(
        await driver.createCart({
          agentToken: token,
          intentHash: str(intent, 'intentHash', 'declare_intent'),
          items: [{ variantId: 'var_that_thing_from_the_reel', quantity: 1 }],
        }),
        'VARIANT_NOT_FOUND',
        'create_cart with an unresolvable Variant',
      );
    },
  },
  {
    id: 'invalid-cap-rest',
    name: 'Registration with a Cap of zero paise',
    face: 'rest',
    category: 'validation errors',
    expected: 'INVALID_CAP validation error; no Agent minted',
    async run(world) {
      const driver = world.driver('rest');
      expectValidationError(
        await driver.registerAgent({ capPaise: 0 }),
        'INVALID_CAP',
        'POST /acp/agents with capPaise 0',
      );
    },
  },
  {
    id: 'invalid-budget-mcp',
    name: 'Intent with a non-positive Budget',
    face: 'mcp',
    category: 'validation errors',
    expected: 'INVALID_BUDGET validation error; no Intent mandate declared',
    async run(world) {
      const driver = world.driver('mcp');
      const { token } = await registerBuyer(driver, 500000);
      expectValidationError(
        await driver.declareIntent({ agentToken: token, want: 'a tee', budgetPaise: 0 }),
        'INVALID_BUDGET',
        'declare_intent with budgetPaise 0',
      );
    },
  },

  // --- Gateway failures ----------------------------------------------------
  {
    id: 'decline-retry-fail-closed-mcp',
    name: 'Decline, bounded retry, fail closed: two gateway declines cancel the Order',
    face: 'mcp',
    category: 'gateway failures',
    expected: 'Order cancelled with a structured Decline; zero charge; no Receipt',
    async run(world) {
      const driver = world.driver('mcp');
      const { token } = await registerBuyer(driver, 500000);
      const { cartHash } = await buildCart(driver, token, {
        want: 'a tee the bank dislikes',
        budgetPaise: 200000,
        items: [{ variantId: TEE_VARIANT, quantity: 1 }],
      });
      const submit = expectOk(
        await timedSubmit(world, driver, { agentToken: token, cartHash, idempotencyKey: randomUUID() }),
        'submit_payment',
      );
      const orderId = str(submit, 'orderId', 'submit_payment');
      const linkId = str(submit, 'gatewayPaymentLinkId', 'submit_payment');

      await world.deliver(world.gateway.failPayment(linkId)); // attempt 1
      const afterFirst = expectOk(
        await driver.getOrderStatus({ agentToken: token, orderId }),
        'get_order_status after one decline',
      );
      check(
        afterFirst['status'] === 'awaiting_payment',
        'one decline must not cancel — a bounded retry remains',
      );

      await world.deliver(world.gateway.failPayment(linkId)); // attempt 2 — the bounded retry
      const final = expectOk(
        await driver.getOrderStatus({ agentToken: token, orderId }),
        'get_order_status after the second decline',
      );
      check(final['status'] === 'cancelled', 'the Order must fail closed after two declines');
      const decline = final['decline'] as Record<string, unknown> | null;
      check(
        decline !== null && decline !== undefined && decline['code'] === 'PAYMENT_DECLINED',
        'the cancellation must carry a structured PAYMENT_DECLINED reason',
      );
      check(
        decline['kind'] === 'decline' && !('recoverable' in decline),
        'the reason is a Decline, never a Refusal (kind "decline", no recoverable)',
      );
      check(
        final['receipt'] === null || final['receipt'] === undefined,
        'zero charge means no Receipt exists to serve',
      );
    },
  },
  {
    id: 'decline-then-success-mcp',
    name: 'Decline, then the bounded retry succeeds',
    face: 'mcp',
    category: 'gateway failures',
    expected: 'One decline recorded; the retry captures; Order paid with Receipt',
    async run(world) {
      const driver = world.driver('mcp');
      const { token } = await registerBuyer(driver, 500000);
      const { cartHash } = await buildCart(driver, token, {
        want: 'a tee, second time lucky',
        budgetPaise: 200000,
        items: [{ variantId: TEE_VARIANT, quantity: 1 }],
      });
      const submit = expectOk(
        await timedSubmit(world, driver, { agentToken: token, cartHash, idempotencyKey: randomUUID() }),
        'submit_payment',
      );
      const orderId = str(submit, 'orderId', 'submit_payment');
      const linkId = str(submit, 'gatewayPaymentLinkId', 'submit_payment');

      await world.deliver(world.gateway.failPayment(linkId));
      await world.deliver(world.gateway.completePayment(linkId));
      await expectPaidWithReceipt(driver, token, orderId, 129900);
    },
  },
  {
    id: 'oversell-refund-cross-face',
    name: 'Oversell and automatic refund: two faces race for the last unit',
    face: 'both',
    category: 'gateway failures',
    expected: 'MCP buyer fulfilled; REST buyer auto-refunded with a linked refund receipt',
    async run(world) {
      // The seeded shelf holds 5 per Variant; drain the tee to exactly one so
      // two verified chains race for the same last unit (PLAN §5.2: no
      // reservations — the race window is deliberate).
      await world.setVariantStock(TEE_VARIANT, 1);

      const buyerA = world.driver('mcp');
      const regA = await registerBuyer(buyerA, 500000);
      const cartA = await buildCart(buyerA, regA.token, {
        want: 'the last tee',
        budgetPaise: 200000,
        items: [{ variantId: TEE_VARIANT, quantity: 1 }],
      });
      const submitA = expectOk(
        await timedSubmit(world, buyerA, {
          agentToken: regA.token,
          cartHash: cartA.cartHash,
          idempotencyKey: randomUUID(),
        }),
        'buyer A submit_payment',
      );

      const buyerB = world.driver('rest');
      const regB = await registerBuyer(buyerB, 500000);
      const cartB = await buildCart(buyerB, regB.token, {
        want: 'that same last tee',
        budgetPaise: 200000,
        items: [{ variantId: TEE_VARIANT, quantity: 1 }],
      });
      const submitB = expectOk(
        await timedSubmit(world, buyerB, {
          agentToken: regB.token,
          cartHash: cartB.cartHash,
          idempotencyKey: randomUUID(),
        }),
        'buyer B submit_payment — both chains verified against one unit',
      );

      // A pays first and is fulfilled.
      await payOrder(world, submitA);
      await expectPaidWithReceipt(buyerA, regA.token, str(submitA, 'orderId', 'submit'), 129900);

      // B pays — capture stands, fulfilment finds the shelf bare, and the
      // webhook route itself runs the automatic refund.
      const outcomes = await world.deliver(
        world.gateway.completePayment(str(submitB, 'gatewayPaymentLinkId', 'submit')),
      );
      check(
        outcomes.some((o) => o['result'] === 'oversell_detected' && o['refund'] === 'order_refunded'),
        `the webhook route must detect the Oversell and refund automatically, got ${JSON.stringify(outcomes)}`,
      );

      const status = expectOk(
        await buyerB.getOrderStatus({
          agentToken: regB.token,
          orderId: str(submitB, 'orderId', 'submit'),
        }),
        'buyer B get_order_status',
      );
      check(status['status'] === 'refunded', 'the oversold Order must end refunded — terminal');
      const oversell = status['oversell'] as Record<string, unknown> | null;
      check(
        oversell !== null && oversell !== undefined && oversell['code'] === 'OVERSOLD',
        'the refund must carry the structured OVERSOLD reason',
      );
      check(
        oversell['kind'] === 'oversell' && !('recoverable' in oversell) && !('attempts' in oversell),
        'an Oversell is neither a Refusal nor a Decline',
      );

      // The receipt pair: the original Receipt stands, the refund receipt
      // references it by hash, and both verify against the merchant key.
      const receipt = status['receipt'] as Record<string, unknown> | null;
      const refundReceipt = status['refundReceipt'] as Record<string, unknown> | null;
      check(
        receipt !== null && receipt !== undefined && refundReceipt !== null && refundReceipt !== undefined,
        'a refunded Order serves both the original Receipt and the refund receipt',
      );
      const receiptPayload = parseReceiptPayload(receipt['payload']);
      const refundPayload = parseRefundReceiptPayload(refundReceipt['payload']);
      const merchantPublicKey = str(refundReceipt, 'merchantPublicKey', 'refundReceipt');
      check(
        verifyMandateSignature(merchantPublicKey, refundPayload, str(refundReceipt, 'signature', 'refundReceipt')),
        'the refund receipt fails independent Ed25519 verification',
      );
      check(
        refundPayload.receiptHash === hashMandate(receiptPayload),
        'the refund receipt must reference the original Receipt by hash — the pair verifies together',
      );
      check(
        refundPayload.amountPaise === receiptPayload.amountPaise,
        'the FULL captured amount was refunded, not a partial',
      );
    },
  },
];
