# T2: Deterministic Gateway Stub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deterministic in-process `PaymentGateway` implementation (`StubGateway`) that mints Payment Links, fires synthetic Razorpay-shaped webhook events, and simulates Declines and Oversells on demand — proven by a fully in-process happy-path purchase with no network calls.

**Architecture:** `StubGateway` implements the existing `PaymentGateway` seam (`src/gateway/types.ts`) exactly as `RazorpayGateway` does, reusing the pure helpers in `razorpayWebhook.ts` for signature verification and payload normalisation (that file's docstring already anticipates this reuse). Synthetic webhooks are returned as `{rawEvent, rawBody, signature}` objects the harness delivers itself — the stub never calls anything. The in-process purchase proof runs `checkout()` → synthetic webhook → `applyGatewayWebhook()` against an embedded PGlite Postgres (WASM, dev-dependency, zero network) with the real drizzle migrations applied, so the append-only audit triggers are exercised too.

**Tech Stack:** TypeScript (Node 22, ESM with `.js` import suffixes), vitest, drizzle-orm, `@electric-sql/pglite` (devDependency only).

**Spec:** GitHub issue #3 (T2), parented by issue #1; PLAN.md §5.4/§5.5/§6. Acceptance criteria: (1) a happy-path purchase runs fully in-process against the stub with no network calls; (2) stub can simulate a decline and an oversell on demand, deterministically; (3) real-rail code paths use the real implementation unchanged (interface swap only).

## Global Constraints

- **No new production dependencies.** `@electric-sql/pglite` enters as a devDependency and must never be imported by any file `tsconfig.build.json` compiles (it excludes `src/**/*.test.ts` and — after Task 2 — `src/testSupport/**`).
- **Nothing above the gateway seam changes.** `checkout.ts`, `orders.ts`, `http/app.ts`, `index.ts` are not modified. `razorpayGateway.ts` stays the only file importing the `razorpay` package.
- **The stub's `name` is exactly `'stub'`** (`types.ts` documents `razorpay` | `stub`; audit payloads and `namespaceGatewayEvent` key off it).
- **Determinism:** no `Date.now()`, no `Math.random()`, no `randomUUID()` in the stub. Sequence counters only. Calling the same script twice on a fresh stub produces byte-identical webhook bodies.
- **Money is integer paise** (`Paise` type from `src/domain/money.ts`); amounts pass through the stub unconverted.
- **Naming discipline:** stub-minted identifiers read `plink_stub_*`, `order_stub_*`, `pay_stub_*` — gateway-side spellings, never colliding with domain `ord_*` ids.
- **Every task ends with `npm test` AND `npm run typecheck` green.** (Engineering log 2026-08-24: green tests with a broken type check has happened here before.)
- Commit messages follow the repo's plain descriptive style (`git log --oneline` shows e.g. "Report S3 from the committed runs, not from memory"). No co-author lines.

---

### Task 1: StubGateway — links, synthetic webhooks, scriptable outcomes

**Files:**
- Create: `src/gateway/stubGateway.ts`
- Create: `src/gateway/stubGateway.test.ts`
- Modify: `src/gateway/types.ts:6-10` (docstring only: the stub now exists)

**Interfaces:**
- Consumes: `PaymentGateway`, `CreatePaymentLinkParams`, `PaymentLink`, `GatewayError` from `./types.js`; `verifyRazorpaySignature`, `parseRazorpayWebhook` from `./razorpayWebhook.js`; `createHmac` from `node:crypto`.
- Produces (Task 2 relies on these exact names):
  - `export const STUB_WEBHOOK_SECRET: string`
  - `export interface SyntheticWebhook { readonly rawEvent: string; readonly rawBody: string; readonly signature: string }`
  - `export class StubGateway implements PaymentGateway` with `readonly name = 'stub'`, the three interface methods, plus:
    - `completePayment(gatewayPaymentLinkId: string): readonly SyntheticWebhook[]` — returns `payment_link.paid` + `payment.captured` deliveries; repeat calls return byte-identical bodies (redelivery); throws `GatewayError` on an unknown link id.
    - `failPayment(gatewayPaymentLinkId: string): readonly SyntheticWebhook[]` — returns one `payment.failed` delivery (a Decline); each call is a new failed attempt with a new deterministic payment id; throws `GatewayError` on an unknown link or a link already paid.

**Behavioural spec (exact values):**
- The Nth `createPaymentLink` call (starting at 1) mints `plink_stub_N`, an internal gateway order `order_stub_N` (mirroring Razorpay: the link mints its own gateway order), url `https://stub.invalid/pay/plink_stub_N`, `status: 'created'`, and returns `gatewayOrderId: null` — the id is learned from the webhook, exactly like real rails (`types.ts` explains why there is no `createGatewayOrder`).
- `completePayment` mints payment id `pay_stub_N` for link N and returns two deliveries, in order: `payment_link.paid`, then `payment.captured` — Razorpay fires several events per purchase, and delivering both is what exercises the handler's idempotency.
- The Kth `failPayment` on link N mints payment id `pay_stub_N_fail{K}`. `completePayment` after `failPayment` is allowed (a retry that succeeded — the T8 decline-retry path needs this); `failPayment` after `completePayment` throws `GatewayError` (a contradictory script is a harness bug, fail loud).
- Webhook bodies are Razorpay-shaped so `parseRazorpayWebhook` normalises them with no stub-specific branch:
  - `payment_link.paid`: `{event, payload: {payment_link: {entity: {id, reference_id, amount, order_id, status: 'paid', notes}}, payment: {entity: {id, amount, order_id, notes}}}}`
  - `payment.captured`: `{event, payload: {payment: {entity: {id, amount, order_id, notes}}}}`
  - `payment.failed`: `{event, payload: {payment: {entity: {id, amount, order_id, status: 'failed', error_code: 'BAD_REQUEST_ERROR', error_description: 'Payment failed at the stub gateway', notes}}}}`
  - `amount` is the link's `amountPaise`; `notes` is the notes map from `createPaymentLink` (it carries `orderId`, which is how a `payment.failed` — which has no `payment_link` entity — still recovers the domain reference).
- Signatures: `HMAC-SHA256(rawBody, secret)` hex — the same scheme `verifyRazorpaySignature` checks. Secret defaults to `STUB_WEBHOOK_SECRET = 'stub-webhook-secret'`, overridable via constructor options `{ webhookSecret?: string }`.
- `verifyWebhookSignature` delegates to `verifyRazorpaySignature(rawBody, signature, secret)`; `parseWebhookEvent` delegates to `parseRazorpayWebhook(rawBody)`.
- Bodies are built once per attempt and stored, so redelivery returns the *stored* strings (byte-identical), not re-serialised ones.

**Steps:**

- [ ] **Step 1: Write the failing tests** — `src/gateway/stubGateway.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { paise } from '../domain/money.js';
import { StubGateway, STUB_WEBHOOK_SECRET } from './stubGateway.js';
import { GatewayError, type CreatePaymentLinkParams } from './types.js';

function linkParams(overrides: Partial<CreatePaymentLinkParams> = {}): CreatePaymentLinkParams {
  return {
    reference: 'ord_0000000000000000000000000000000a',
    amountPaise: paise(129900),
    currency: 'INR',
    description: 'Oversized Tee × 1',
    callbackUrl: 'https://merchant.example/payment-callback?orderId=ord_0000000000000000000000000000000a',
    notes: { orderId: 'ord_0000000000000000000000000000000a', merchantId: 'mrc_test' },
    ...overrides,
  };
}

describe('StubGateway.createPaymentLink', () => {
  it('mints deterministic sequenced ids and echoes the amount', async () => {
    const gateway = new StubGateway();
    const first = await gateway.createPaymentLink(linkParams());
    expect(first).toEqual({
      gatewayPaymentLinkId: 'plink_stub_1',
      url: 'https://stub.invalid/pay/plink_stub_1',
      amountPaise: 129900,
      status: 'created',
      gatewayOrderId: null,
    });
    const second = await gateway.createPaymentLink(linkParams({ reference: 'ord_0000000000000000000000000000000b' }));
    expect(second.gatewayPaymentLinkId).toBe('plink_stub_2');
  });

  it('two fresh stubs given the same script produce identical links', async () => {
    const a = await new StubGateway().createPaymentLink(linkParams());
    const b = await new StubGateway().createPaymentLink(linkParams());
    expect(a).toEqual(b);
  });
});

describe('StubGateway.completePayment', () => {
  it('returns payment_link.paid then payment.captured, both verifiable and parseable', async () => {
    const gateway = new StubGateway();
    const link = await gateway.createPaymentLink(linkParams());
    const hooks = gateway.completePayment(link.gatewayPaymentLinkId);

    expect(hooks.map((h) => h.rawEvent)).toEqual(['payment_link.paid', 'payment.captured']);
    for (const hook of hooks) {
      expect(gateway.verifyWebhookSignature(hook.rawBody, hook.signature)).toBe(true);
    }

    const paid = gateway.parseWebhookEvent(hooks[0]!.rawBody);
    expect(paid).toEqual({
      kind: 'payment_succeeded',
      rawEvent: 'payment_link.paid',
      reference: 'ord_0000000000000000000000000000000a',
      gatewayOrderId: 'order_stub_1',
      gatewayPaymentId: 'pay_stub_1',
      gatewayPaymentLinkId: 'plink_stub_1',
      amountPaise: 129900,
    });

    const captured = gateway.parseWebhookEvent(hooks[1]!.rawBody);
    expect(captured.kind).toBe('payment_succeeded');
    expect(captured.rawEvent).toBe('payment.captured');
    // payment.captured carries no payment_link entity; the reference comes from notes.
    expect(captured.reference).toBe('ord_0000000000000000000000000000000a');
    expect(captured.gatewayOrderId).toBe('order_stub_1');
    expect(captured.amountPaise).toBe(129900);
  });

  it('redelivers byte-identical bodies on repeat calls', async () => {
    const gateway = new StubGateway();
    const link = await gateway.createPaymentLink(linkParams());
    const first = gateway.completePayment(link.gatewayPaymentLinkId);
    const again = gateway.completePayment(link.gatewayPaymentLinkId);
    expect(again).toEqual(first);
  });

  it('throws GatewayError for an unknown payment link', () => {
    expect(() => new StubGateway().completePayment('plink_stub_404')).toThrow(GatewayError);
  });
});

describe('StubGateway.failPayment', () => {
  it('returns a verifiable payment.failed Decline that still recovers the reference', async () => {
    const gateway = new StubGateway();
    const link = await gateway.createPaymentLink(linkParams());
    const hooks = gateway.failPayment(link.gatewayPaymentLinkId);

    expect(hooks).toHaveLength(1);
    expect(gateway.verifyWebhookSignature(hooks[0]!.rawBody, hooks[0]!.signature)).toBe(true);
    const event = gateway.parseWebhookEvent(hooks[0]!.rawBody);
    expect(event.kind).toBe('payment_failed');
    expect(event.rawEvent).toBe('payment.failed');
    expect(event.reference).toBe('ord_0000000000000000000000000000000a');
    expect(event.gatewayPaymentId).toBe('pay_stub_1_fail1');
  });

  it('numbers repeated declines so retry-then-fail is scriptable', async () => {
    const gateway = new StubGateway();
    const link = await gateway.createPaymentLink(linkParams());
    gateway.failPayment(link.gatewayPaymentLinkId);
    const second = gateway.failPayment(link.gatewayPaymentLinkId);
    expect(gateway.parseWebhookEvent(second[0]!.rawBody).gatewayPaymentId).toBe('pay_stub_1_fail2');
  });

  it('allows completePayment after a failure (a retry that succeeded)', async () => {
    const gateway = new StubGateway();
    const link = await gateway.createPaymentLink(linkParams());
    gateway.failPayment(link.gatewayPaymentLinkId);
    const hooks = gateway.completePayment(link.gatewayPaymentLinkId);
    expect(gateway.parseWebhookEvent(hooks[0]!.rawBody).kind).toBe('payment_succeeded');
  });

  it('refuses to fail a link that already paid — a contradictory script is a harness bug', async () => {
    const gateway = new StubGateway();
    const link = await gateway.createPaymentLink(linkParams());
    gateway.completePayment(link.gatewayPaymentLinkId);
    expect(() => gateway.failPayment(link.gatewayPaymentLinkId)).toThrow(GatewayError);
  });
});

describe('StubGateway signature scheme', () => {
  it('rejects a tampered body and accepts only the configured secret', async () => {
    const gateway = new StubGateway();
    const link = await gateway.createPaymentLink(linkParams());
    const [hook] = gateway.completePayment(link.gatewayPaymentLinkId);
    expect(gateway.verifyWebhookSignature(hook!.rawBody + ' ', hook!.signature)).toBe(false);

    const custom = new StubGateway({ webhookSecret: 'other-secret' });
    expect(custom.verifyWebhookSignature(hook!.rawBody, hook!.signature)).toBe(false);
    expect(STUB_WEBHOOK_SECRET).toBe('stub-webhook-secret');
  });
});
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `npx vitest run src/gateway/stubGateway.test.ts`
Expected: FAIL — cannot resolve `./stubGateway.js`.

- [ ] **Step 3: Implement `src/gateway/stubGateway.ts`**

```typescript
import { createHmac } from 'node:crypto';
import type { Paise } from '../domain/money.js';
import { parseRazorpayWebhook, verifyRazorpaySignature } from './razorpayWebhook.js';
import {
  GatewayError,
  type CreatePaymentLinkParams,
  type GatewayWebhookEvent,
  type PaymentGateway,
  type PaymentLink,
} from './types.js';

/**
 * The deterministic in-process gateway (T2, PLAN §5.4).
 *
 * Everything the real gateway does over the network, this does as data: it
 * mints Payment Links (each with its own internal gateway order, exactly as a
 * Razorpay link does), and hands back Razorpay-shaped webhook bodies for the
 * harness to deliver itself. It never calls anything, reads no clock, and
 * draws no randomness — the Nth call on a fresh stub always yields the same
 * bytes, which is what makes the eval suite CI-runnable (PLAN §6) and is the
 * only reliable way to trigger a Decline programmatically (§5.5: test mode has
 * no API-driven payment completion).
 *
 * Webhook verification and parsing reuse the pure helpers in
 * `razorpayWebhook.ts`, so synthetic events exercise the identical
 * normalisation path real ones do — no stub-specific branch exists above the
 * seam.
 *
 * Scripting: `completePayment` / `failPayment` are the "on demand" levers.
 * A Decline is one `failPayment`; the bounded-retry-then-fail-closed
 * rehearsal (T8) is two; an Oversell (T9) is two Orders' payments completed
 * against stock that only covers one — the stub completes captures on
 * command, and the shortfall is the domain's to discover at fulfilment.
 */

export const STUB_WEBHOOK_SECRET = 'stub-webhook-secret';

export interface StubGatewayOptions {
  readonly webhookSecret?: string;
}

/** One synthetic delivery: the exact bytes and signature a harness POSTs. */
export interface SyntheticWebhook {
  readonly rawEvent: string;
  readonly rawBody: string;
  readonly signature: string;
}

interface StubLink {
  readonly seq: number;
  readonly gatewayPaymentLinkId: string;
  /** Minted with the link, exactly as Razorpay does — learned via webhook. */
  readonly gatewayOrderId: string;
  readonly reference: string;
  readonly amountPaise: Paise;
  readonly notes: Readonly<Record<string, string>>;
  outcome: 'pending' | 'failed' | 'paid';
  failedAttempts: number;
  /** Stored on first settle so redelivery is byte-identical. */
  paidDeliveries: readonly SyntheticWebhook[] | null;
}

export class StubGateway implements PaymentGateway {
  readonly name = 'stub';

  readonly #secret: string;
  readonly #links = new Map<string, StubLink>();
  #seq = 0;

  constructor(options: StubGatewayOptions = {}) {
    this.#secret = options.webhookSecret ?? STUB_WEBHOOK_SECRET;
  }

  async createPaymentLink(params: CreatePaymentLinkParams): Promise<PaymentLink> {
    const seq = ++this.#seq;
    const link: StubLink = {
      seq,
      gatewayPaymentLinkId: `plink_stub_${seq}`,
      gatewayOrderId: `order_stub_${seq}`,
      reference: params.reference,
      amountPaise: params.amountPaise,
      notes: { ...params.notes },
      outcome: 'pending',
      failedAttempts: 0,
      paidDeliveries: null,
    };
    this.#links.set(link.gatewayPaymentLinkId, link);
    return {
      gatewayPaymentLinkId: link.gatewayPaymentLinkId,
      url: `https://stub.invalid/pay/${link.gatewayPaymentLinkId}`,
      amountPaise: params.amountPaise,
      status: 'created',
      // Deliberately withheld, like the real create response may withhold it:
      // the authoritative id arrives on the webhook (`gateway.order_linked`).
      gatewayOrderId: null,
    };
  }

  verifyWebhookSignature(rawBody: string, signature: string): boolean {
    return verifyRazorpaySignature(rawBody, signature, this.#secret);
  }

  parseWebhookEvent(rawBody: string): GatewayWebhookEvent {
    return parseRazorpayWebhook(rawBody);
  }

  /**
   * Settle a link as paid. Returns the deliveries Razorpay would fire —
   * `payment_link.paid` then `payment.captured` — so delivering both
   * exercises the handler's idempotency. Repeat calls are redelivery:
   * the same stored bytes come back.
   */
  completePayment(gatewayPaymentLinkId: string): readonly SyntheticWebhook[] {
    const link = this.#requireLink(gatewayPaymentLinkId);
    if (link.paidDeliveries !== null) return link.paidDeliveries;

    const gatewayPaymentId = `pay_stub_${link.seq}`;
    const paymentEntity = {
      id: gatewayPaymentId,
      amount: link.amountPaise,
      order_id: link.gatewayOrderId,
      notes: link.notes,
    };
    const deliveries: readonly SyntheticWebhook[] = [
      this.#delivery('payment_link.paid', {
        payment_link: {
          entity: {
            id: link.gatewayPaymentLinkId,
            reference_id: link.reference,
            amount: link.amountPaise,
            order_id: link.gatewayOrderId,
            status: 'paid',
            notes: link.notes,
          },
        },
        payment: { entity: paymentEntity },
      }),
      this.#delivery('payment.captured', { payment: { entity: paymentEntity } }),
    ];
    link.outcome = 'paid';
    link.paidDeliveries = deliveries;
    return deliveries;
  }

  /**
   * Settle an attempt as a Decline. Each call is a fresh failed attempt with
   * its own payment id, so decline → retry → decline is scriptable (T8).
   */
  failPayment(gatewayPaymentLinkId: string): readonly SyntheticWebhook[] {
    const link = this.#requireLink(gatewayPaymentLinkId);
    if (link.outcome === 'paid') {
      throw new GatewayError(
        `Payment link ${gatewayPaymentLinkId} already paid; a decline after capture is a contradictory script`,
      );
    }
    link.outcome = 'failed';
    link.failedAttempts += 1;
    return [
      this.#delivery('payment.failed', {
        payment: {
          entity: {
            id: `pay_stub_${link.seq}_fail${link.failedAttempts}`,
            amount: link.amountPaise,
            order_id: link.gatewayOrderId,
            status: 'failed',
            error_code: 'BAD_REQUEST_ERROR',
            error_description: 'Payment failed at the stub gateway',
            notes: link.notes,
          },
        },
      }),
    ];
  }

  #requireLink(gatewayPaymentLinkId: string): StubLink {
    const link = this.#links.get(gatewayPaymentLinkId);
    if (link === undefined) {
      throw new GatewayError(`Unknown payment link ${gatewayPaymentLinkId}; create it before settling it`);
    }
    return link;
  }

  #delivery(rawEvent: string, payload: Record<string, unknown>): SyntheticWebhook {
    const rawBody = JSON.stringify({ event: rawEvent, payload });
    const signature = createHmac('sha256', this.#secret).update(rawBody, 'utf8').digest('hex');
    return { rawEvent, rawBody, signature };
  }
}
```

- [ ] **Step 4: Update the `types.ts` docstring** — lines 6–10 currently say "Two implementations are planned and only one exists today". Reword to state both exist, e.g.:

```
 * Two implementations:
 *   - `RazorpayGateway` (T1) — the real Razorpay Node SDK, test mode.
 *   - `StubGateway` (T2) — deterministic and in-process: mints Payment Links,
 *     returns synthetic webhook events for the harness to deliver, and
 *     simulates Declines and Oversells on demand so the scripted eval suite
 *     is CI-runnable.
```

- [ ] **Step 5: Run the tests, verify they pass**

Run: `npx vitest run src/gateway/stubGateway.test.ts`
Expected: PASS (all tests).

- [ ] **Step 6: Full suite + typecheck**

Run: `npm test && npm run typecheck`
Expected: all tests pass (85 pre-existing + new), typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add src/gateway/stubGateway.ts src/gateway/stubGateway.test.ts src/gateway/types.ts
git commit -m "T2: deterministic gateway stub — links, synthetic webhooks, scriptable outcomes"
```

---

### Task 2: In-process purchase proof — happy path, Decline, Oversell on PGlite

**Files:**
- Create: `src/testSupport/pgliteDatabase.ts`
- Create: `src/gateway/stubGateway.integration.test.ts`
- Modify: `package.json` (add devDependency `@electric-sql/pglite`)
- Modify: `tsconfig.build.json` (exclude `src/testSupport/**` from the build)
- Modify: `vitest.config.ts` (comment only — it currently claims "no database"; now tests run against an embedded one, still no network)
- Modify: `README.md` ("Not built yet" list: T2 is built; one short paragraph in the gateway section describing the stub)

**Interfaces:**
- Consumes (from Task 1): `StubGateway`, `SyntheticWebhook` from `src/gateway/stubGateway.js`. From the existing codebase: `checkout` (`src/domain/checkout.ts`), `applyGatewayWebhook`, `findOrderById` (`src/domain/orders.ts`), `schema` tables (`src/db/schema.ts`), `Database` type (`src/db/client.ts`), `Refusal` (`src/domain/refusal.ts`).
- Produces: `createTestDatabase(): Promise<{ db: Database; close(): Promise<void> }>` in `src/testSupport/pgliteDatabase.ts` — later suites (T5 enforcement tests, T15 evals) will reuse it.

**Steps:**

- [ ] **Step 1: Add the dev dependency**

Run: `npm install --save-dev @electric-sql/pglite`
Expected: package.json + lockfile updated. (Engineering log 2026-08-24: the lockfile must be generated under npm 10 — check `npm -v` is 10.x before installing; this project pins `packageManager: npm@10.9.3`.)

- [ ] **Step 2: Exclude test support from the build** — `tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "exclude": ["node_modules", "dist", "src/**/*.test.ts", "src/testSupport/**"]
}
```

- [ ] **Step 3: Write the test-support database helper** — `src/testSupport/pgliteDatabase.ts`:

```typescript
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { Database } from '../db/client.js';
import * as schema from '../db/schema.js';

/**
 * An embedded, in-memory Postgres for tests — real SQL, real transactions,
 * the real committed migrations (including 0001's append-only triggers on
 * `audit_events`), zero network. This directory is excluded from
 * `tsconfig.build.json`, so PGlite stays a devDependency.
 */

export interface TestDatabaseHandle {
  readonly db: Database;
  close(): Promise<void>;
}

export async function createTestDatabase(): Promise<TestDatabaseHandle> {
  const client = new PGlite();
  const db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder: 'drizzle' });
  // `Database` is nominally the Neon driver's type; the PGlite instance has
  // the same query/transaction surface the domain code uses. One cast here,
  // in test support, rather than widening the production type for a test.
  return { db: db as unknown as Database, close: () => client.close() };
}
```

- [ ] **Step 4: Write the failing integration tests** — `src/gateway/stubGateway.integration.test.ts`:

```typescript
import { asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StorefrontDeps } from '../deps.js';
import { auditEvents, merchants, products, variants } from '../db/schema.js';
import { checkout } from '../domain/checkout.js';
import { applyGatewayWebhook, findOrderById } from '../domain/orders.js';
import { createTestDatabase, type TestDatabaseHandle } from '../testSupport/pgliteDatabase.js';
import { StubGateway, type SyntheticWebhook } from './stubGateway.js';

/**
 * T2's acceptance proof: a purchase runs fully in-process — StubGateway for
 * the rails, embedded PGlite for the database — with no network calls, and
 * Declines and Oversells are scriptable on demand (issue #3).
 *
 * Webhook delivery mirrors `http/app.ts`'s route exactly: verify signature
 * over the raw bytes, parse, then `applyGatewayWebhook`.
 */

const MERCHANT_ID = 'mrc_test_merchant';

async function seedCatalog(db: StorefrontDeps['db'], stock: number): Promise<void> {
  await db.insert(merchants).values({ id: MERCHANT_ID, name: 'Test Merchant' });
  await db.insert(products).values({
    id: 'prd_test_tee',
    merchantId: MERCHANT_ID,
    title: 'Oversized Tee',
    status: 'published',
  });
  await db.insert(variants).values({
    id: 'var_test_tee_default',
    productId: 'prd_test_tee',
    label: null,
    isDefault: true,
    pricePaise: 129900,
    currency: 'INR',
    stock,
  });
}

async function deliver(deps: StorefrontDeps, hook: SyntheticWebhook) {
  // The same three steps the webhook route performs, minus the socket.
  expect(deps.gateway.verifyWebhookSignature(hook.rawBody, hook.signature)).toBe(true);
  const event = deps.gateway.parseWebhookEvent(hook.rawBody);
  return applyGatewayWebhook(deps.db, deps.merchantId, event, deps.gateway.name);
}

describe('in-process purchase against the stub', () => {
  let handle: TestDatabaseHandle;
  let gateway: StubGateway;
  let deps: StorefrontDeps;

  beforeEach(async () => {
    handle = await createTestDatabase();
    gateway = new StubGateway();
    deps = {
      db: handle.db,
      gateway,
      merchantId: MERCHANT_ID,
      publicBaseUrl: 'https://merchant.example',
    };
  });

  afterEach(async () => {
    await handle.close();
  });

  it('happy path: checkout → synthetic webhooks → Order paid, audit chain complete', async () => {
    await seedCatalog(deps.db, 3);

    const result = await checkout(deps, { merchantId: MERCHANT_ID, quantity: 1 });
    expect(result.status).toBe('awaiting_payment');
    expect(result.gatewayPaymentLinkId).toBe('plink_stub_1');
    expect(result.paymentLinkUrl).toBe('https://stub.invalid/pay/plink_stub_1');
    expect(result.total.amountPaise).toBe(129900);

    const hooks = gateway.completePayment(result.gatewayPaymentLinkId);
    const first = await deliver(deps, hooks[0]!);
    expect(first).toEqual({ result: 'order_paid', orderId: result.orderId });
    // Razorpay fires sibling events for one purchase; the second must be free.
    const second = await deliver(deps, hooks[1]!);
    expect(second).toEqual({ result: 'already_paid', orderId: result.orderId });

    const order = await findOrderById(deps.db, MERCHANT_ID, result.orderId);
    expect(order?.status).toBe('paid');
    expect(order?.gatewayOrderId).toBe('order_stub_1');
    expect(order?.gatewayPaymentId).toBe('pay_stub_1');
    expect(order?.paidAt).not.toBeNull();

    const chain = await deps.db
      .select({ type: auditEvents.type, payload: auditEvents.payload })
      .from(auditEvents)
      .where(eq(auditEvents.orderId, result.orderId))
      .orderBy(asc(auditEvents.seq));
    expect(chain.map((e) => e.type)).toEqual([
      'order.created',
      'gateway.payment_link_attempted',
      'gateway.payment_link_issued',
      'gateway.webhook_received',
      'gateway.order_linked',
      'order.paid',
      'gateway.webhook_received',
    ]);
    // Namespaced, so the rule-auditor never meets two meanings of one spelling.
    expect((chain[3]!.payload as { gatewayEvent: string }).gatewayEvent).toBe('stub:payment_link.paid');
    expect((chain[5]!.payload as { gateway: string }).gateway).toBe('stub');

    // Redelivery of an already-applied success is still free.
    const redelivered = await deliver(deps, hooks[0]!);
    expect(redelivered).toEqual({ result: 'already_paid', orderId: result.orderId });
  });

  it('Decline on demand: payment.failed is recorded and the Order never becomes paid', async () => {
    await seedCatalog(deps.db, 3);
    const result = await checkout(deps, { merchantId: MERCHANT_ID, quantity: 1 });

    const declined = await deliver(deps, gateway.failPayment(result.gatewayPaymentLinkId)[0]!);
    expect(declined).toEqual({ result: 'recorded', orderId: result.orderId });

    const afterDecline = await findOrderById(deps.db, MERCHANT_ID, result.orderId);
    expect(afterDecline?.status).toBe('awaiting_payment');
    expect(afterDecline?.paidAt).toBeNull();

    // The retry that succeeds (T8's bounded-retry path needs this scriptable).
    const paid = await deliver(deps, gateway.completePayment(result.gatewayPaymentLinkId)[0]!);
    expect(paid).toEqual({ result: 'order_paid', orderId: result.orderId });
  });

  it('Oversell on demand: two captures land against stock that covers one', async () => {
    await seedCatalog(deps.db, 1);

    // No reservations, deliberately (spec: the race window is what makes the
    // Oversell failure real). Both checkouts pass the pre-payment stock check.
    const a = await checkout(deps, { merchantId: MERCHANT_ID, quantity: 1 });
    const b = await checkout(deps, { merchantId: MERCHANT_ID, quantity: 1 });

    for (const r of [a, b]) {
      const outcome = await deliver(deps, gateway.completePayment(r.gatewayPaymentLinkId)[0]!);
      expect(outcome).toEqual({ result: 'order_paid', orderId: r.orderId });
    }

    // Both Orders are paid; stock still says 1: the shortfall now exists for
    // T9's fulfilment-time check to discover and refund. That is the Oversell,
    // manufactured deterministically.
    const [variantRow] = await deps.db.select().from(variants).where(eq(variants.id, 'var_test_tee_default'));
    expect(variantRow?.stock).toBe(1);
    const orderA = await findOrderById(deps.db, MERCHANT_ID, a.orderId);
    const orderB = await findOrderById(deps.db, MERCHANT_ID, b.orderId);
    expect(orderA?.status).toBe('paid');
    expect(orderB?.status).toBe('paid');
    expect((orderA?.quantity ?? 0) + (orderB?.quantity ?? 0)).toBeGreaterThan(variantRow?.stock ?? 0);
  });
});
```

- [ ] **Step 5: Run the integration tests, verify they fail only for the missing helper/dep** (then pass once Steps 1–3 are in place — if Steps 1–3 were done first, expect PASS here; the meaningful red state for this task is the suite failing before Task 1's stub existed)

Run: `npx vitest run src/gateway/stubGateway.integration.test.ts`
Expected: PASS. If PGlite fails to run the migrations (e.g. trigger syntax), STOP and report — that is a real finding about the harness, not something to patch around by weakening the test.

- [ ] **Step 6: Update the vitest config comment** — `vitest.config.ts`:

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // In-process only: pure helpers plus integration tests on an embedded
    // PGlite Postgres. No external network, no credentials (PLAN §6).
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
```

- [ ] **Step 7: Update README.md** — in "Not built yet", remove the T2 bullet and add a short paragraph to the gateway section (after the paragraph beginning "**The gateway sits behind an interface.**") noting the stub exists: deterministic, in-process, mints `plink_stub_*` links, returns synthetic webhook deliveries the harness posts itself, `completePayment`/`failPayment` script captures and Declines, and an Oversell is two completed captures against stock that covers one. Keep the README's voice (present tense, mechanism-first).

- [ ] **Step 8: Full suite + typecheck + build**

Run: `npm test && npm run typecheck && npm run build`
Expected: everything green; `dist/` contains no `testSupport` output and no pglite import (verify: `ls dist | grep -i testsupport` finds nothing, `grep -r pglite dist` finds nothing).

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json tsconfig.build.json vitest.config.ts src/testSupport/pgliteDatabase.ts src/gateway/stubGateway.integration.test.ts README.md
git commit -m "T2: prove the in-process purchase — happy path, Decline, Oversell on embedded Postgres"
```

---

## Plan-level notes for the controller

- **Ruling (pre-made): no `GATEWAY` env switch.** Acceptance criterion 3 is a constraint (nothing above the seam changes), not a feature: the deployed server stays Razorpay-only; the eval runner (T15) and tests construct `StubGateway` directly at their own composition points. `src/index.ts` is untouched.
- **Ruling (pre-made): the happy-path proof delivers webhooks via the same verify→parse→apply sequence the Express route runs**, not through an HTTP socket — "in-process, no network" is the criterion, and the route adds only transport.
- Task 2 depends on Task 1's exports; do not parallelise.
