# agent-store

Merchant-side agentic commerce infrastructure for India's long-tail sellers: take a
merchant's messy real-world catalog and make them transactable by AI buyer agents, with
every money action explainable, bounded, and gated.

Domain vocabulary is canonical in [`CONTEXT.md`](CONTEXT.md); the plan and milestones are
in [`PLAN.md`](PLAN.md); deep decisions are in [`docs/adr/`](docs/adr/) and the running
design log is [`DECISIONS.md`](DECISIONS.md). What broke and what to not walk into twice is
in [`docs/engineering-log.md`](docs/engineering-log.md); the live-eval procedure is in
[`docs/live-evals.md`](docs/live-evals.md).

> **Test mode, permanently.** This project never touches live payment credentials. The
> server refuses to start on anything but a `rzp_test_…` key.

---

## What exists today

Everything below is merged on `main` and deployed. A buyer agent connected over MCP (or
the REST twin) registers, declares an Intent, gets an immutable Cart mandate back, and pays
for it on real Razorpay test-mode rails — with every step signed, bounded by a Cap and a
Budget, and written to an append-only audit log a separate auditor re-checks.

| Surface | What it does |
|---|---|
| `POST /mcp` | Authless MCP (Streamable HTTP, stateless). Six tools: `get_product`, `register_agent`, `declare_intent`, `create_cart`, `submit_payment`, `get_order_status`. |
| `GET /.well-known/agent-store.json` | Discovery doc describing both protocol faces: the MCP endpoint and the REST base + endpoints, auth model, money conventions, failure shapes. |
| `/acp/*` | The ACP-flavored REST twin (T14): `GET /acp/products`, `POST /acp/agents`, `POST /acp/intents`, `POST /acp/carts`, `POST /acp/payments`, `GET /acp/orders/:orderId` — the same core and trust layer as MCP, `Authorization: Bearer <agentToken>`. Refusals and Receipts are identical in shape on both faces. |
| `POST /webhooks/razorpay` | Verifies the Razorpay webhook signature, then flips the domain Order to `paid` — or writes an anomaly and leaves it alone. |
| `GET /audit`, `/audit/:orderId`, `/audit/refusals/:seq` | The audit directory, one Order's ordered event chain, and a standalone Refusal (addressed by audit `seq`, since a Refusal has no Order), as JSON. |
| `/viewer/*` | The React ledger SPA (T7, T13) over those endpoints: directory, Order timeline, Refusal timeline, and the merchant confirmation queue at `/viewer/confirm`. |
| `/merchant/confirmations` | The confirmation screen's API (T13): the worklist of Products held in `needs-confirmation`, and the publish-on-confirm write. Every publish decision is made server-side, so a client speaking raw HTTP meets the same wall as the UI. |
| `GET /payment-callback` | Where Razorpay returns the human's browser after they approve. Cosmetic — the webhook is what marks the Order paid. |
| `GET /healthz` | Health check; also the keep-warm ping target. |

The flow the mandate chain drives:

```
buyer agent --register_agent--> Agent + Cap declared      (audit: agent.registered)
            --declare_intent--> Intent mandate signed     (audit: mandate.intent_declared)
            --create_cart-----> immutable Cart mandate,
                                both sides signed,
                                price hash pinned         (audit: mandate.cart_created)
            --submit_payment--> Cap/Budget/stock/idempotency checked
                                Payment mandate verified  (audit: payment.verified)
                                domain Order created      (audit: order.created)
                                about to call Razorpay    (audit: gateway.payment_link_attempted)
                                Payment Link issued       (audit: gateway.payment_link_issued)
      human --approves-------->  the hosted link          <- the consent step
   Razorpay --webhook-------->  signature verified        (audit: gateway.webhook_received)
                                real gateway order id     (audit: gateway.order_linked)
                                amount asserted, stock decremented,
                                Order paid                (audit: order.paid)
                                merchant-signed Receipt   (audit: receipt.issued)
```

Every trust-layer check runs *before* any gateway call, so a Refusal always means zero money
moved. The `*_attempted` event is written *before* the outbound call, so a crash mid-request
leaves a trace rather than a silence. Anything that arrives but cannot be safely acted on
writes `order.anomaly_detected` and leaves the Order untouched — see "fail closed" below.
Two post-yes failures are handled and rehearsable in one command each: a **Decline** (the
original attempt plus exactly one bounded retry, then the Order fails closed to `cancelled`,
zero charge) and an **Oversell** (a stock shortfall found at fulfilment, *after* capture →
automatic refund, merchant-signed Refund receipt, terminal `refunded`).

Catalog comes from the ingestion pipeline (T12): merchant photo captions in → per-field
confidence out → fields at or above the auto-publish threshold (0.90) publish themselves,
anything below holds the *whole* Product in `needs-confirmation` until the merchant approves
or corrects it on `/viewer/confirm`. The deployed demo catalog is 29 Products / 92 Variants,
₹299–₹3,799, ingested from the 28-caption demo dataset plus the seeded walking-skeleton
product.

### What's worth knowing about the code

**Money is integer paise, INR only.** `src/domain/money.ts` is the only place amounts are
constructed. Formatting is one-way and parsing is explicit and fallible, so no float can
reach an amount. Razorpay is paise-denominated too, so paise cross the gateway boundary
unconverted and there is no rounding step to get wrong.

**Audit events commit with their state change** (ADR-0003). `appendAuditEvent` takes a
`Transaction`, not any database handle — writing an audit event outside a transaction is a
type error, not a code-review finding. Migration `0001` additionally installs triggers that
refuse `UPDATE` and `DELETE` on `audit_events`, so the log is append-only at the database.
This is what the rule-auditor's "judged from the audit log alone" claim rests on (T15 — see Scoreboard).

**The gateway sits behind an interface.** `src/gateway/types.ts` defines `PaymentGateway`;
`razorpayGateway.ts` is the only file in the repo that imports the `razorpay` package. The
deterministic stub implements the same interface — nothing above the seam changes.

`src/gateway/stubGateway.ts` is that stub. It reads no clock and draws no randomness, so the
Nth call on a fresh instance always yields the same bytes. It mints `plink_stub_*` Payment
Links and returns Razorpay-shaped webhook bodies, already signed, for the caller to deliver
itself rather than waiting to be called over a socket. `completePayment` scripts a capture,
`failPayment` scripts a Decline, and an Oversell is two completed captures against stock that
covers one. `stubGateway.integration.test.ts` runs a whole purchase through it — checkout,
webhooks, Order paid, audit chain — on an embedded PGlite Postgres carrying the committed
migrations, with no network anywhere. Tests and the eval harness construct the stub at their
own composition points; `src/index.ts` stays Razorpay-only.

The interface deliberately has **no `createGatewayOrder`**. A Razorpay Payment Link mints
its *own* internal gateway order, so creating one ourselves produced an object no payment
would ever hit, whose id then contradicted the real one arriving on the webhook. The
Payment Link is the only checkout-time gateway artifact, and `gatewayOrderId` is *learned*
from the webhook and written exactly once (`gateway.order_linked`).

**It fails closed, and never overwrites.** A verified webhook does **not** mark an Order paid
when the amount is missing or differs from the Order's, when it reports a gateway order id
conflicting with one already recorded, or when more than one Order matched it. Each case
writes `order.anomaly_detected` and leaves the Order exactly as it was. Webhook-to-Order
matching tries strategies in strict priority order (our own reference first) rather than
OR-ing them into one query — which Order gets marked paid is not a decision a query planner
should be making.

**Naming discipline.** Razorpay's objects are always `gatewayOrderId` / `gatewayPaymentId` /
`gatewayPaymentLinkId`. A bare `orderId` always means our domain Order. Gateway event names
are namespaced wherever they are recorded (`razorpay:order.paid`), because Razorpay has an
event spelled `order.paid` and so do we — the rule-auditor must never meet two meanings of
one spelling. This holds in the schema, the code, the audit payloads, and the JSON on the wire.

**Every signature is verified, wherever the key lives.** An Agent registers either
custodial (the server mints and holds an Ed25519 keypair and signs on its behalf) or
client-custody (`private_key IS NULL` — the Agent signs locally and the server only ever
verifies against the registered public key). ADR-0004 fixes custody at registration; both
kinds buy through the same tools, and `submit_payment` re-verifies the whole chain —
Intent → Cart → Payment, bound by embedded hashes — before anything reaches the gateway.
`src/buyer/` is a working client-custody buyer, which is also what the live suite drives.

**Refusals and validation errors are different types.** A **Refusal** is the trust layer
saying no on policy before money moves, and always carries
`{code, reason, recoverable, retryAfter?}`. The vocabulary is closed and lives in one union:
`OUT_OF_STOCK`, `UNREGISTERED_AGENT`, `OVER_BUDGET`, `OVER_CAP`, `IDEMPOTENCY_REUSE`,
`INTENT_CONSUMED`, `PRICE_CHANGED`, `INVALID_MANDATE`.
A malformed argument is a plain **validation error** with a deliberately different shape
(`{code, message}` — no `recoverable`), so neither a buyer agent nor the rule-auditor can
confuse the two categories. A gateway **Decline** is a third thing again and lives on the
webhook path. See `src/domain/refusal.ts` and CONTEXT.md → Failure vocabulary.

### Where the build stands

Milestones are in [`PLAN.md`](PLAN.md) §8; each one's recorded check result lives there.

| | |
|---|---|
| **M1** walking skeleton, deployed | done |
| **M2** trust layer — registration, mandate chain, Cap/Budget, idempotency, price-hash pinning, Receipts | done |
| **M3** audit-trail viewer | done |
| **M4** ingestion + demo dataset + confirmation screen + measured accuracy | done |
| **M5** rehearsed failures | scripted halves done (`npm run failure:decline`, `npm run failure:oversell`); the real-rails takes (a live `failure@razorpay` decline; the refund visible in the Razorpay dashboard) are manual and not yet recorded |
| **M6** eval harness | scripted suite done (30/30, auditor clean — see Scoreboard). The live suite's harness is merged and the committed report holds 3 real runs from 2026-08-27; those predate the payer-bot fix and the full catalog, so re-running them is the open item |
| **M7** release — demo video, public repo | not started |

Deliberately not built, and not planned for v1: WhatsApp price-list ingestion (schedule-gated
secondary format), a second demo merchant, and the upsell tool — the top of `PLAN.md` §9's
de-scope ladder. The rest of the cut list is in "What v1 does not do" below.

---

## Scoreboard

Produced by `npm run evals` — the 30-scenario scripted protocol suite plus the
rule-auditor, in one deterministic, CI-runnable command. The reference run's
artifacts are committed so no number here has to be taken on trust:
[`evals/protocol-report.json`](evals/protocol-report.json) (per-scenario results) and
[`evals/protocol-audit-log.jsonl`](evals/protocol-audit-log.jsonl) — the batch's
exported `audit_events` rows, the *only* input the auditor reads, re-checkable any
time with `npm run audit:rules`. Re-running `npm run evals` reproduces all of it:

| Metric | Value | Measured how |
|---|---|---|
| Task success (30 scripted protocol scenarios) | **30/30 (100%)** | Scenario runner over both protocol faces (18 MCP, 10 REST, 2 cross-face) against the deterministic gateway stub on embedded Postgres. Every scenario states its expected outcome and fails otherwise. |
| Audited violations | **0** | The rule-auditor, reading **only the audit log** the batch produced — 250 audit events: 10 charges, 18 refusals, 30 agent registrations. See "The rule-auditor" below. |
| Extraction accuracy per field | name **27/28 (96%)** · price **28/28 (100%)** · stock **28/28 (100%)** · variant labels **28/28 (100%)** · description presence **28/28 (100%)** — the committed run is [`fixtures/demo-dataset/runs/gpt-5-mini.json`](fixtures/demo-dataset/runs/gpt-5-mini.json); reproduce with `npm run ingest:accuracy`. | gpt-5-mini (`gpt-5-mini-2025-08-07`) over the 28-item demo catalog vs [published hand labels](fixtures/demo-dataset/) written before any model ran, both published in this repo. |
| p95 checkout latency | **111.6 ms** (17 successful `submit_payment` calls) | Wall-clock around each successful `submit_payment`: full mandate-chain verification (4 Ed25519 verifications + hash binding), Cap/Budget/stock/idempotency enforcement, Order + Payment-mandate persistence, payment-link issuance — against the in-process stub, so this is **protocol overhead only** and excludes real Razorpay network time. |

### Methodology — which numbers come from the stub, which from real rails

**From the stub (deterministic):** the 30 scripted scenarios and everything in the
table above. They run against `StubGateway` (PLAN §5.4) on an embedded PGlite
Postgres carrying the real committed migrations — no network, no credentials, byte-stable
across runs, which is what makes the suite CI-runnable and the only way to trigger a
gateway decline programmatically (test mode has no API-driven payment completion). The
scenario list covers: happy purchases on both faces (custodial and client-custody
signing), out-of-stock mid-cart, over-Cap, over-Budget, an ambiguous query that resolves
to no Variant, price change between cart and payment, a replayed Payment mandate, a
reused idempotency key with a different cart, a second purchase on a consumed Intent,
decline + bounded retry + fail-closed, Oversell + automatic refund, malformed/tampered
mandates, an unregistered agent, refusal-shape parity across the two faces, and
validation-error cases — run `npm run evals` for the full list with per-scenario results.

**From real rails (non-deterministic, reported separately):** the live suite
(`npm run evals:live`, [docs/live-evals.md](docs/live-evals.md)) — real
Claude-as-buyer runs against the deployed endpoint on real Razorpay test rails, payment
approved by a Playwright payer-bot. Those runs are observations, not test cases, and
their report says so — nothing in the table above comes from them.
[`evals/live-report.md`](evals/live-report.md) currently holds one batch of 3 runs
(2026-08-27): one purchase that reached a real Payment Link and then failed in the
*payer-bot* at Razorpay's hosted page, and two reasoned walk-aways against what was then a
3-product catalog. The payer-bot has since been fixed (it drives mobile checkout and pays
via the UPI intent tile) and verified to complete a real purchase end to end against
production; re-running the batch on the full catalog is the open M6 item. The S1 spike
(PLAN §7) separately verified two complete purchases end-to-end on real test rails.

**Extraction accuracy** is measured against hand labels written before any model ran and
[published in this repo](fixtures/demo-dataset/) — the graded answers are public, so the
grading can be checked, not trusted.

### The rule-auditor (`npm run audit:rules`)

A separate script whose **only input is the audit log** — the append-only
`audit_events` table (exported to `evals/protocol-audit-log.jsonl` by the eval run; the
database refuses `UPDATE`/`DELETE` on it by trigger). It never reads app state, scenario
results, or any agent's claims, and it *recomputes* rather than re-reads: replaying the
log in sequence order it asserts —

1. **No charge above Cap** — every charge is attributed to its Agent through the logged
   verification event, and the running captured-minus-refunded total per Agent never
   exceeds the Cap that Agent's registration event declared.
2. **No charge without a complete verified mandate chain** — every charge traces back
   through hash-linked Intent → Cart → Payment events of the same Agent, the Cart's
   total re-added from its logged line items, the charged amount consistent across the
   chain and within the Intent's logged Budget.
3. **No duplicate charge per idempotency key** — at most one verified Payment mandate
   and one charge per (Agent, key); a replay must reference a key the log saw verify.
4. **Every Refusal has a reason code** — each refusal event carries the structured
   `{code, reason, recoverable}` payload.

An auditor that cannot fail proves nothing, so the test suite feeds it planted
violations — synthetic bad logs for each assert, plus a *real* exported log tampered
after the fact (Cap shrunk below a real charge; the verification event deleted) — and
requires it to catch every one (`src/evals/protocol/ruleAuditor.test.ts`,
`protocolSuite.integration.test.ts`).

---

## Running it locally

Requires Node 22 and a Neon Postgres database.

```bash
npm install
cp .env.example .env      # then fill it in — see the table below
npm run db:migrate        # apply drizzle/ migrations
npm run db:seed           # one merchant, one published Product, one default Variant
npm run dev               # http://localhost:3000
npm run dev:viewer        # the React viewer against that server, with HMR
```

Checks:

```bash
npm run typecheck   # tsc --noEmit, strict
npm run build       # server (tsc -> dist/) + viewer (vite -> dist/viewer)
npm test            # vitest: 292 tests — pure helpers plus in-process integration, no network
npm run evals       # the 30-scenario protocol suite + rule-auditor (see Scoreboard)
npm run audit:rules # re-audit the last eval batch's exported audit log on its own
```

The rest of the commands, each producing an artifact you can look at:

```bash
npm run ingest:demo       # the 28-caption demo dataset through the ingestion pipeline
npm run ingest:accuracy   # extraction accuracy vs the published hand labels (needs OPENAI_API_KEY)
npm run failure:decline   # rehearsed failure 1: decline, one bounded retry, fail closed
npm run failure:oversell  # rehearsed failure 2: oversell at fulfilment, automatic refund
npm run evals:live -- --target <url>   # the live Claude-as-buyer suite (real rails; see docs/live-evals.md)
npm run evals:probe -- --target <url>  # tune the Playwright payer-bot with no model spend
```

`npm test` covers pure helpers (paise arithmetic and formatting, audit event ordering, the
Refusal/validation-error split, webhook signature verification and payload parsing,
id/reference handling) and the in-process purchase proof, which runs against the stub gateway
and an embedded PGlite Postgres. No credentials, no external service — PGlite is a
devDependency and `tsconfig.build.json` excludes `src/testSupport/`, so it never reaches
`dist/`. Everything else with a seam cost is tested at the protocol surface by the T15 eval
harness rather than mocked here — see `PLAN.md` §6 and the Scoreboard above.

### Environment variables

| Variable | Required | What it is |
|---|---|---|
| `DATABASE_URL` | yes | Neon **pooled** connection string (host contains `-pooler`). The pooled/WebSocket driver is mandatory: the HTTP driver cannot hold an interactive transaction, and ADR-0003 needs one. |
| `RAZORPAY_KEY_ID` | yes | Test key from the Razorpay dashboard (Account & Settings → API Keys, Test mode). Must start with `rzp_test_`. |
| `RAZORPAY_KEY_SECRET` | yes | Its secret. |
| `RAZORPAY_WEBHOOK_SECRET` | yes | The secret you typed when creating the webhook pointing at `{PUBLIC_BASE_URL}/webhooks/razorpay`. |
| `PUBLIC_BASE_URL` | yes | This deployment's public HTTPS origin, no trailing slash. Used for the Payment Link callback URL and the audit URLs handed back to agents. |
| `PORT` | no | Defaults to `3000`. Render and Railway set this themselves. |
| `OPENAI_API_KEY` | no | Only for ingestion (`npm run ingest:demo`, `npm run ingest:accuracy`) — the server never reads it. |
| `EXTRACTION_MODEL` | no | Ingestion model id; defaults to `gpt-5-mini`, which is what the committed accuracy run used. |

The server validates all of these at startup and names every missing one at once.

### Razorpay webhook setup

In the Razorpay dashboard (Test mode) → Account & Settings → Webhooks, add
`{PUBLIC_BASE_URL}/webhooks/razorpay` with the secret from `RAZORPAY_WEBHOOK_SECRET`, and
subscribe to at least `payment_link.paid`, `payment.captured`, and `order.paid`. All three
are handled and the handler is idempotent — Razorpay sends more than one for a single
purchase and redelivers on any non-2xx.

A verified webhook is always answered `200`, including when it matched no Order, tripped an
anomaly check, or could not be parsed at all: a non-2xx would only make Razorpay redeliver a
body that will be just as unacceptable next time. Unparseable signed bodies are logged
loudly, since they mean the integration itself has drifted. An *unsigned* body gets `401`.

To complete a payment in test mode, open the returned link and pay with the UPI id
`success@razorpay`. Note the trap in `PLAN.md` §5.5: *cancelling* a UPI payment in test mode
still produces a **successful** payment, so "user cancels" is not a failure scenario.

---

## Deploying

Two deployments run the same commit against the same Neon database:

| | |
|---|---|
| **Railway** (primary) | <https://agent-store-production-8345.up.railway.app> — `railway.json`; does not sleep, so a judge's first tool call pays no cold start. Migrations and the seed run in `preDeployCommand`, which completes before any container serves traffic (Railway's *build* sandbox cannot open the Neon WebSocket). |
| **Render** (fallback) | <https://agent-store-e4ka.onrender.com> — `render.yaml`, free plan, Node 22, Singapore, health check on `/healthz`. Migrations and the seed run in the build command, so a failed migration fails the deploy rather than crash-looping the service. |

**Neither platform deploys on merge.** Railway has no GitHub source connected (`railway up`
only) and Render's blueprint is deployed by hand. Merging is not deploying — push the
deploy yourself, one platform at a time, and check `/healthz` before the next.

Standing up your own:

1. Create a Neon project; copy the **pooled** connection string.
2. Create the service — Railway from `railway.json`, or a Render Blueprint from `render.yaml`.
3. Fill in the four secret env vars in the platform dashboard. `PUBLIC_BASE_URL` can only be
   set after the first deploy assigns a URL — set it, then redeploy.
4. Point the Razorpay webhook at `{PUBLIC_BASE_URL}/webhooks/razorpay`.
5. Add a repository **variable** `RENDER_URL` (Settings → Secrets and variables → Actions →
   Variables) with the deployed origin. `.github/workflows/keep-warm.yml` then pings
   `/healthz` every 10 minutes so a sleeping free-tier service is warm on arrival. Until
   that variable exists, the workflow runs and exits cleanly.

---

## Connecting a Claude client

### claude.ai custom connector

Settings → Connectors → **Add custom connector**, and paste:

```
https://agent-store-production-8345.up.railway.app/mcp
```

No authentication — leave OAuth fields empty. The transport is authless by decision
(`PLAN.md` §3, §5.2): identity, authorization and spend control live *in* the protocol —
the agent token and mandate chain of T3/T4 — not in a transport header. Transport auth is
documented as deployment-specific hardening and is out of scope for v1.

Then ask Claude to buy something. It will call `get_product`, `register_agent` (declaring
its own Cap), `declare_intent`, `create_cart`, `submit_payment` — and hand back a payment
link for you to approve. Approve it with `success@razorpay`, then ask Claude to call
`get_order_status`, and open `{PUBLIC_BASE_URL}/viewer` to watch the whole chain replay:
each mandate, each verification, the Receipt. Ask it to buy something over its own declared
Cap instead and the Refusal gets its own timeline.

### Claude Code (testing and fallback)

```bash
claude mcp add --transport http agent-store https://agent-store-production-8345.up.railway.app/mcp
```

Or against a local server: `claude mcp add --transport http agent-store http://localhost:3000/mcp`.

---

## What v1 does not do

Written down so the scope is legible rather than implied (`PLAN.md` §10):

- **No real payments, ever.** Test mode is enforced in code, not in discipline.
- **No UAP/AP2 compliance claim.** The mandate chain is *shaped* by those designs; no
  public UAP spec exists to conform to.
- **No Magic Checkout or Turbo UPI** — both need merchant onboarding. Standard Payment
  Links is the honest surface for this build.
- **No multi-merchant marketplace discovery.** Merchant is a first-class entity with its
  own signing key, but one deployment serves one merchant, `merchantId` from config.
- **No merchant analytics dashboard**, and no merchant login — the confirmation screen and
  the audit endpoints are public by design in v1.
- **No transport-layer auth** (OAuth, static headers). Identity, authorization and spend
  control live *in* the protocol; transport auth is deployment-specific hardening.
- **No stock reservations.** The deliberate consequence is the Oversell path: money can
  move and then be automatically sent back, with a Refund receipt, rather than a cart being
  silently invalidated.
- **No ONDC schema**, no WhatsApp price-list ingestion, no upsell tool, no second merchant.

---

## Threat model note

An **Agent** is nothing more than its registration (ADR-0001) — one keypair plus a token.
Sybil re-registration to obtain a fresh Cap is an explicit v1 non-goal, documented rather
than papered over: there is nothing to anchor a durable identity to while the transport is
authless, and a verified agent registry is precisely what NPCI's UAP is expected to provide.
The rule-auditor's "no charge above Cap" claim is therefore scoped per Agent registration,
and its report says so.
