# agent-store

Merchant-side agentic commerce infrastructure for India's long-tail sellers: take a
merchant's messy real-world catalog and make them transactable by AI buyer agents, with
every money action explainable, bounded, and gated.

Domain vocabulary is canonical in [`CONTEXT.md`](CONTEXT.md); the plan and milestones are
in [`PLAN.md`](PLAN.md); deep decisions are in [`docs/adr/`](docs/adr/).

> **Test mode, permanently.** This project never touches live payment credentials. The
> server refuses to start on anything but a `rzp_test_…` key.

---

## What exists today (M1 — walking skeleton)

A buyer agent connected over MCP can see one published product and buy it end to end on
real Razorpay test-mode rails:

| Surface | What it does |
|---|---|
| `POST /mcp` | Authless MCP (Streamable HTTP, stateless). Tools: `get_product`, `checkout`, `get_order_status`. |
| `POST /webhooks/razorpay` | Verifies the Razorpay webhook signature, then flips the domain Order to `paid`. |
| `GET /audit/:orderId` | The ordered audit event chain for one Order, as JSON. |
| `GET /payment-callback` | Where Razorpay returns the human's browser after they approve. Cosmetic — the webhook is what marks the Order paid. |
| `GET /healthz` | Health check; also the keep-warm ping target. |

The flow `checkout` drives:

```
buyer agent  --checkout-->  domain Order created      (audit: order.created)
                            about to call Razorpay    (audit: gateway.payment_link_attempted)
                            Payment Link issued       (audit: gateway.payment_link_issued)
       human --approves-->  the hosted link           <- the consent step
    Razorpay --webhook-->   signature verified        (audit: gateway.webhook_received)
                            real gateway order id     (audit: gateway.order_linked)
                            amount asserted, Order paid (audit: order.paid)
```

The `*_attempted` event is written *before* the outbound call, so a crash mid-request
leaves a trace rather than a silence. Anything that arrives but cannot be safely acted on
writes `order.anomaly_detected` and leaves the Order untouched — see "fail closed" below.

### The five things worth knowing about the code

**Money is integer paise, INR only.** `src/domain/money.ts` is the only place amounts are
constructed. Formatting is one-way and parsing is explicit and fallible, so no float can
reach an amount. Razorpay is paise-denominated too, so paise cross the gateway boundary
unconverted and there is no rounding step to get wrong.

**Audit events commit with their state change** (ADR-0003). `appendAuditEvent` takes a
`Transaction`, not any database handle — writing an audit event outside a transaction is a
type error, not a code-review finding. Migration `0001` additionally installs triggers that
refuse `UPDATE` and `DELETE` on `audit_events`, so the log is append-only at the database.
This is what the T6 rule-auditor's "judged from the audit log alone" claim rests on.

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

**Refusals and validation errors are different types.** A **Refusal** is the trust layer
saying no on policy before money moves, and always carries
`{code, reason, recoverable, retryAfter?}`; today that is `OUT_OF_STOCK` (T1) and
`UNREGISTERED_AGENT` (T3 — a commerce call without a valid agent token).
A malformed argument is a plain **validation error** with a deliberately different shape
(`{code, message}` — no `recoverable`), so neither a buyer agent nor the rule-auditor can
confuse the two categories. A gateway **Decline** is a third thing again and lives on the
webhook path. See `src/domain/refusal.ts` and CONTEXT.md → Failure vocabulary.

### Not built yet

Since T3, `checkout` and `get_order_status` refuse `UNREGISTERED_AGENT` unless called with
a valid agent token from `register_agent` (which mints a custodial Ed25519 keypair and
records the buyer-declared Cap). The rest of the trust layer lands in the gap between
"resolve the Variant" and "create the Order" — `src/domain/checkout.ts` marks it as an
explicit, commented phase that runs *before* any gateway call, so a Refusal will always
mean zero money moved.

- **T4** — the Intent → Cart → Payment mandate chain, Budget enforcement, cumulative Cap
  enforcement at payment time (the Cap itself is declared and stored at registration since
  T3), idempotency, price-hash pinning, signed Receipts.
- **T7** — the React audit viewer over `GET /audit/:orderId`.
- Ingestion (M4), the ACP-flavored REST twin, and `/.well-known` discovery.

---

## Running it locally

Requires Node 22 and a Neon Postgres database.

```bash
npm install
cp .env.example .env      # then fill it in — see the table below
npm run db:migrate        # apply drizzle/ migrations
npm run db:seed           # one merchant, one published Product, one default Variant
npm run dev               # http://localhost:3000
```

Checks:

```bash
npm run typecheck   # tsc --noEmit, strict
npm run build       # tsc -> dist/
npm test            # vitest: pure helpers plus in-process integration, no network
```

`npm test` covers pure helpers (paise arithmetic and formatting, audit event ordering, the
Refusal/validation-error split, webhook signature verification and payload parsing,
id/reference handling) and the in-process purchase proof, which runs against the stub gateway
and an embedded PGlite Postgres. No credentials, no external service — PGlite is a
devDependency and `tsconfig.build.json` excludes `src/testSupport/`, so it never reaches
`dist/`. Everything else with a seam cost is tested at the protocol surface by the T6 eval
harness rather than mocked here — see `PLAN.md` §6.

### Environment variables

| Variable | Required | What it is |
|---|---|---|
| `DATABASE_URL` | yes | Neon **pooled** connection string (host contains `-pooler`). The pooled/WebSocket driver is mandatory: the HTTP driver cannot hold an interactive transaction, and ADR-0003 needs one. |
| `RAZORPAY_KEY_ID` | yes | Test key from the Razorpay dashboard (Account & Settings → API Keys, Test mode). Must start with `rzp_test_`. |
| `RAZORPAY_KEY_SECRET` | yes | Its secret. |
| `RAZORPAY_WEBHOOK_SECRET` | yes | The secret you typed when creating the webhook pointing at `{PUBLIC_BASE_URL}/webhooks/razorpay`. |
| `PUBLIC_BASE_URL` | yes | This deployment's public HTTPS origin, no trailing slash. Used for the Payment Link callback URL and the audit URLs handed back to agents. |
| `PORT` | no | Defaults to `3000`. Render sets this itself. |

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

`render.yaml` describes a free Render web service (Node 22, Singapore, health check on
`/healthz`). Migrations and the seed run in the build command, so a failed migration fails
the deploy rather than crash-looping the service.

1. Create a Neon project; copy the **pooled** connection string.
2. In Render, create a Blueprint from this repo. Render reads `render.yaml`.
3. Fill in the four `sync: false` env vars in the Render dashboard. `PUBLIC_BASE_URL` can
   only be set after the first deploy assigns a URL — set it, then redeploy.
4. Point the Razorpay webhook at `{PUBLIC_BASE_URL}/webhooks/razorpay`.
5. Add a repository **variable** `RENDER_URL` (Settings → Secrets and variables → Actions →
   Variables) with the deployed origin. `.github/workflows/keep-warm.yml` then pings
   `/healthz` every 10 minutes so a judge's first tool call doesn't pay a cold start. Until
   that variable exists, the workflow runs and exits cleanly.

---

## Connecting a Claude client

### claude.ai custom connector

Settings → Connectors → **Add custom connector**, and paste:

```
https://<your-service>.onrender.com/mcp
```

No authentication — leave OAuth fields empty. The transport is authless by decision
(`PLAN.md` §3, §5.2): identity, authorization and spend control live *in* the protocol —
the agent token and mandate chain of T3/T4 — not in a transport header. Transport auth is
documented as deployment-specific hardening and is out of scope for v1.

Then ask Claude to buy something. It will call `get_product`, then `checkout`, and hand back
a payment link for you to approve. Approve it with `success@razorpay`, then ask Claude to
call `get_order_status` — and open `{PUBLIC_BASE_URL}/audit/<orderId>` to see the whole
chain.

### Claude Code (testing and fallback)

```bash
claude mcp add --transport http agent-store https://<your-service>.onrender.com/mcp
```

Or against a local server: `claude mcp add --transport http agent-store http://localhost:3000/mcp`.

---

## Threat model note

An **Agent** is nothing more than its registration (ADR-0001) — one keypair plus a token.
Sybil re-registration to obtain a fresh Cap is an explicit v1 non-goal, documented rather
than papered over: there is nothing to anchor a durable identity to while the transport is
authless, and a verified agent registry is precisely what NPCI's UAP is expected to provide.
The rule-auditor's "no charge above Cap" claim is therefore scoped per Agent registration,
and its report says so.
