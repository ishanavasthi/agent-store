# agent-store — merchant-side agentic commerce infrastructure

**Status:** Plan finalized 2026-08-22 (rev 2, post design review). Implementation starts with the Day-1 spikes below.
**Ship target:** v1 public by **Sep 2–3, 2026**. Sep 4–5 is slip buffer only, never scheduled work.

---

## 1. Problem statement

India's payment rails are agent-ready — UPI Reserve Pay is live, agentic checkout pilots run on ChatGPT and Claude, NPCI's UAP is reportedly coming — but India's long-tail merchants are not. A D2C seller running on Instagram captions and WhatsApp price lists has no machine-readable catalog, no stock/price API, no protocol endpoint: at the moment an AI buyer agent tries to buy from them, the sale is simply impossible. **agent-store** takes that merchant's messy real-world catalog and makes them agent-transactable end to end. Solved means: a real Claude client discovers the merchant, negotiates a cart, and pays through Razorpay test-mode rails — with every money action explainable, bounded, and gated, and the whole thing replayable from an audit trail.

### Done when (v1, observable outcomes)

- A real Claude client (claude.ai custom connector), pointed at the **deployed** MCP endpoint, drives a complete purchase — discovery → cart → signed mandate chain → checkout. The human's single act is approving the payment on the Razorpay-hosted link (the consent step, mirroring how UPI Reserve Pay separates authorization from agent action). The payment appears in the Razorpay test-mode dashboard.
- The ingestion pipeline turns the demo merchant's Instagram-style photos+captions into a confirmed catalog, with extraction accuracy reported against **published** hand labels.
- A rule-auditor that reads **only the audit log** reports zero cap/mandate violations across the full eval batch.
- Both rehearsed failures (§5.6) reproduce on command and render fully in the audit viewer.
- Public repo + demo video + architecture doc by Sep 3.

---

## 2. Protocol landscape (Aug 2026, context)

- **NPCI UAP** — reported July 2026; national framework to register/verify/authorize AI agents on UPI rails. **No public spec; awaits RBI approval.** Our trust layer is a working preview of what UAP will need.
- **AP2** (Google) — signed **Intent → Cart → Payment mandates**; the authorization/trust layer. We borrow its vocabulary (ap2-protocol.org) without claiming compliance.
- **ACP** (OpenAI+Stripe) — the checkout layer; powers ChatGPT Instant Checkout. Our REST face is ACP-flavored.
- **UPI Reserve Pay** — the live consent primitive (one-time consent + per-merchant spend cap) our caps and consent-step demo mirror.

**The gap we attack:** India's rails are ahead of its merchants. Nobody has shipped the India-native merchant-side stack for long-tail sellers.

---

## 3. Decisions (locked — log in DECISIONS.md)

| Question | Decision |
|---|---|
| Name / repo | **agent-store** (this repo, public at release) |
| Stack | **TypeScript end-to-end**: Node 22 + TS everywhere. Express + official MCP TypeScript SDK (Streamable HTTP) + Razorpay Node SDK. React (Vite) SPA served by the same Express app for audit viewer + merchant confirmation. |
| Persistence | **Neon Postgres** (free tier, no expiry) + Drizzle ORM. (Not SQLite: Render's filesystem is ephemeral and the audit log must survive redeploys. Not Render free Postgres: 30-day deletion cliff.) |
| Deployment | **Deployed from day 1**: Render free web service (public URL for webhooks + remote MCP) kept warm by a GitHub Actions ping workflow (every 10 min). |
| Hero | **Merchant-side infra**: messy catalog in → agent-transactable merchant out. Buyer agent is a demo counterpart only. |
| Buyer-facing surface | **MCP-first + ACP-flavored REST twin** — same core, two protocol faces, plus `/.well-known/agent-store.json` discovery doc. |
| MCP auth | **Authless transport; identity in-protocol.** `register_agent` issues an agent token passed as a tool argument; the mandate chain + caps are the security layer. (Static-header auth on claude.ai connectors is beta-gated; OAuth+DCR buys nothing this project is about.) |
| Payment completion | No API-only completion exists in plain test mode (verified). **Live demo:** human approves the hosted payment link with `success@razorpay` — the consent step. **Evals:** deterministic gateway stub for the scripted suite; Playwright payer-bot only for the real-rail subset. |
| Key custody | **Split.** claude.ai buyer = custodial (server-held Ed25519 keypair, token-authenticated sessions). Agent SDK eval buyer = client-side key, signs locally — proving non-custodial works. |
| Ingestion v1 | **Photos+captions primary** (incl. Hinglish/emoji robustness as a *stated* feature); WhatsApp price-list text **secondary — built only if on schedule at the Aug 31 checkpoint**. Plain TS pipeline (no agent framework) calling a vision model. |
| Extraction model | **gpt-5-mini** (OpenAI key), behind a one-line-swappable interface. S3 gate: <~70% name+price exact-match → step up to **gpt-5** → still below → K2 fires. |
| Model/credit routing | All buyer-flow iteration via **Claude Code (Max subscription)**. Live eval runs via **Agent SDK riding the same Max auth**. ~$4 Anthropic API credits = emergency reserve only. Stealth/preview models: never. |
| Demo clients | Hero demo: **claude.ai free-account custom connector** (free plan supports one connector — verified). Testing/fallback: Claude Code via `claude mcp add --transport http`. |
| Eval harness | **Hybrid**: 30 scripted protocol-level scenarios against the gateway stub (deterministic, one command, CI-runnable) + 3–5 real Claude-as-buyer runs on real test rails, reported separately. Rule-auditor reads only the audit log. |
| Demo merchant | Small D2C streetwear brand, ~25–30 products, gpt-image-1 product shots + hand-written Hinglish captions, hand-labeled ground truth (published in repo). Second merchant (home bakery) only from buffer. |
| Upsell `suggest_addons` | Stretch only — first item on the de-scope ladder, last item added. |
| Repo posture | Repo reads as an infrastructure project. Release/submission logistics live in git-ignored `private/`. |

Domain vocabulary is canonical in **`CONTEXT.md`** (grilling round 2026-08-23; decisions logged in DECISIONS.md, deep ones in `docs/adr/`). Load-bearing terms: **Agent** (= one registration, ADR-0001) · **Order** vs **gateway order** · **Cart mandate** (no stored cart, ADR-0002) · **Variant** (the sellable unit) · **Budget** vs **Cap** · **Refusal** vs **Decline**.

---

## 4. Components (four, one job each)

1. **Ingestion pipeline** — photos+captions → structured catalog (name, price, variants, stock, description) with per-field confidence. Fields at/above threshold auto-publish; any below-threshold field holds the **whole product** in `needs-confirmation` (product lifecycle `draft → needs-confirmation → published`) until the merchant confirms or corrects it on the confirmation screen — no half-visible products. **Stock is a required field**: captions rarely state quantities, so missing stock always blocks publishing (a defaulted stock number would be fiction in exactly the field the rule-auditor reasons about) — which conveniently guarantees the confirmation screen appears in the demo. Ground-truthed against hand labels; accuracy reported honestly. Hinglish/emoji captions ("₹499/- only, DM to order 🔥") are in-scope test cases, not accidents.
2. **Storefront core** — catalog + checkout engine, one codebase, two faces: per-merchant MCP server (`search_catalog`, `get_product`, `create_cart`, `checkout`, `get_order_status`) and ACP-flavored REST (discovery doc + catalog + checkout). `create_cart` is one-shot (full variant-level item list in → immutable Cart mandate out; no cart-editing tools — ADR-0002). Checkout creates real Razorpay **test-mode** gateway orders/Payment Links; webhooks confirm payment (test UPI `success@razorpay`). Merchant is a first-class entity (ID, signing key), but v1 has no merchant-scoped routing — one deployment, `merchantId` in config.
3. **Trust layer (mini-UAP)** — agent registration → identity + Reserve-Pay-style per-merchant cap. Money moves only through the signed mandate chain (§5). Any violation → hard refusal with machine-readable reason. Every action appends to the audit log; the **audit viewer** replays any purchase as a human-readable timeline.
4. **Eval harness** — the signature move. §6.

---

## 5. Design

### 5.1 Purchase flow

Buyer (Claude via MCP) → `search_catalog` → buyer assembles its item list in its own context (**no stored cart** — changing the cart means calling `create_cart` again; ADR-0002) → **Intent mandate** (want + **budget**, buyer-signed) → `create_cart` returns the immutable **Cart mandate** (exact variant-level items + total + **price hash**, signed both sides) → buyer signs **Payment mandate** (references cart hash + idempotency key) → trust layer verifies signature, intent unconsumed, budget, cap, idempotency, stock, price-hash → **gateway order** + Payment Link created at Razorpay → human approves the link (consent step) → webhook confirms → domain **Order** marked paid → signed **machine-readable receipt** returned to the buyer → audit trail complete.

### 5.2 Trust-layer spec sketch (decide fully at implementation, but this is the shape)

- **Keys:** Ed25519 (`@noble/ed25519`). Custody is split (§3): custodial keypairs for connector-based buyers, client-side keys for the Agent SDK buyer (local signing helper). Server holds a per-merchant signing key. Public keys exchanged at registration.
- **Mandates:** canonical-JSON payloads, detached Ed25519 signatures. Chain binding by hash: Cart mandate embeds `sha256(intentMandate)`; Payment mandate embeds `sha256(cartMandate)` + idempotency key. Cart pins a **price hash** — checkout fails closed if catalog price changed after signing. The paid chain is strictly **1:1:1**: unpaid Cart mandates coexist freely (no TTL, no invalidation), but an Intent mandate is **consumed** by its first paid Cart mandate — later attempts refuse `INTENT_CONSUMED` (closes the N-carts-under-one-budget hole; ADR-0002).
- **Identity:** an Agent *is* its registration — one keypair + token, no stable buyer identity behind it; Sybil re-registration is a documented v1 non-goal (ADR-0001). Cap and idempotency scoping key off the Agent row.
- **Spend limits, both enforced:** cart total ≤ intent-mandate **budget** (refusal `OVER_BUDGET`); `sum(captured + pending payments for agent×merchant) + thisAmount ≤ cap` (refusal `OVER_CAP`), checked in a transaction. Cap is declared by the buyer at `register_agent` and immutable for that registration's lifetime.
- **Idempotency:** buyer-minted key (SDK helper generates UUIDs) scoped to agent×merchant; replay with the same cart hash returns the original result, never a second charge; the same key with a *different* cart hash refuses `IDEMPOTENCY_REUSE`.
- **Stock:** no reservations anywhere — checked at payment-mandate verification, re-checked at fulfillment; the race window between them is deliberate (it's what makes the oversell failure real). Decrement happens at the fulfillment check, atomically: `UPDATE ... SET stock = stock - qty WHERE stock >= qty`; a missed row = oversell → refund path.
- **Receipts:** merchant-signed proof binding chain to charge — Order ID, all three mandate hashes, amount, gateway payment ID, timestamp. The oversell refund emits a signed **refund receipt** referencing the original.
- **Audit atomicity:** every state transition commits in the same DB transaction as its audit event — the log is complete by construction, but the system is *not* event-sourced (ADR-0003). Mutating money/order state outside such a transaction is a bug by definition.
- **Money:** integer paise, INR only — no floating point anywhere money is computed or compared (Razorpay is already paise-denominated).
- **Refusals:** `{code, reason, recoverable, retryAfter?}` — structured, LLM-recoverable. "Refusal" is the narrow term: trust-layer policy no, before money moves. A gateway **decline** (after the trust layer said yes) and a validation error are different things and never called refusals.
- **Transport/identity boundary (document explicitly):** the MCP endpoint is authless at the transport layer; identity, authorization, and spend control live in the protocol (registration token + mandate chain + caps). Transport auth is deployment-specific hardening, out of scope for v1.
- **Principles:** LLMs never compute money — deterministic code does totals, caps, refunds; LLMs classify, extract, explain. Mandate verification is code, not prompts. Stated explicitly in the README.

### 5.3 Demo dataset (scheduled work, not an afterthought)

~25–30 streetwear products: gpt-image-1 product shots + hand-written realistic captions (Hinglish, emoji, inconsistent price formats, some missing fields on purpose — caption messiness is the test payload, so captions are authored by hand, never generated). Hand-labeled ground-truth JSON **published in the repo**. Matching WhatsApp price-list export for the secondary format. Budget: ~half a day inside M4.

### 5.4 Gateway stub

The Razorpay client sits behind an interface with two implementations: the real SDK, and a deterministic in-process fake that mints orders/links, fires synthetic webhook events, and can **simulate declines and oversells on demand**. The stub is what makes the scripted eval suite deterministic and CI-runnable — and it is the only reliable way to trigger a decline programmatically (test mode has no API-driven payment completion; a real decline requires driving `failure@razorpay` through the hosted page). Real-rail runs use the real implementation unchanged.

### 5.5 Known test-mode traps

- **Cancelling** a UPI payment in test mode still produces a **successful** payment — "user cancels" is never a failure scenario.
- Refund API works only against **captured** test payments.
- No S2S/API-only payment path on an unactivated account (feature is support-gated) — do not build on the undocumented `payments/create/ajax` endpoint.

### 5.6 The two rehearsed failures

1. **Decline, fail closed:** payment declines → one bounded retry (max 1) → retry also fails → order cancelled with structured reason, zero charge, buyer notified.
2. **Oversell, refund:** payment captured → fulfillment-time stock check finds an oversell → automatic refund via API → buyer notified with structured reason.

Both scripted, reproducible on command, fully visible in the audit viewer. The live-video decline is driven manually with `failure@razorpay` on the hosted link.

---

## 6. Eval harness architecture

- **Protocol suite (the 30):** TS scenario runner hitting MCP/REST surfaces programmatically against the gateway stub — happy purchases, out-of-stock mid-cart, over-cap attempt, over-budget attempt, ambiguous query, price change between cart and payment, replayed payment mandate, reused idempotency key with a different cart, second purchase on a consumed intent, decline + retry + fail-closed, oversell + refund, malformed mandate, unregistered agent. Deterministic, one command, CI-runnable.
- **Live suite (3–5):** real Claude buyer via the Agent SDK (Max subscription auth), end to end against the deployed endpoint on real test rails, payment completed by a Playwright payer-bot driving the hosted link. Reported separately (non-deterministic by nature; say so).
- **Rule-auditor:** separate script that reads **only the audit log** (not agent claims, not app state) and asserts: no charge above cap, no charge without a complete verified mandate chain, no duplicate charge per idempotency key, every refusal has a reason code.
- **Scoreboard in README:** task success %, violations (independently audited: 0), extraction accuracy vs hand labels, p95 checkout latency. Methodology section states plainly which scenarios ran against the stub and which against real rails.

---

## 7. Unknowns

**Design-changing — spike each on Day 1 (Aug 22–23), timebox 0.5d total, paste results here tagged Verified/Likely/Assumption:**

- **S1 — Razorpay test mode works end to end as assumed.** Test keys → create Order + Payment Link via Node SDK → approve link manually with `success@razorpay` → webhook received on a deployed Render URL. (Test mode itself is instant/no-KYC — verified.) → *Spike result: [pending]*
- **S2 — Remote MCP connectivity.** Minimal authless MCP server (Streamable HTTP) on Render; connect from the claude.ai free-account custom connector, and from Claude Code as fallback client. → *Spike result: [pending]*
- **S3 — Extraction quality floor.** Run gpt-5-mini on 5 realistic Hinglish captions+photos. <~70% name+price exact-match → retry with gpt-5; still below → K2 fires. → *Spike result: [pending]*

**Detail-level (resolve when reached):** exact Razorpay webhook event names & signature verification · refund API shape in test mode · Neon serverless driver / pooling with Drizzle · Playwright mechanics against the hosted payment-link page · claude.ai free-account usage limits during demo takes.

---

## 8. Milestones (riskiest first; every check must be able to fail)

At every milestone boundary: **STOP — run the check, record the result here, re-read §9 kill criteria, re-plan 10 minutes.** Detail past the next unfinished milestone stays one line.

**M1 — Walking skeleton, deployed (Aug 22–24).** One hardcoded product; MCP `checkout` tool creates a real test-mode Payment Link; webhook flips the order to paid; audit log records every step; deployed on Render + Neon; ping workflow live.
**Check:** from claude.ai (free account) connected to the public MCP URL, buy the product — human approves the link; the payment shows in the Razorpay test dashboard; `GET /audit/<orderId>` returns the event chain.

**M2 — Trust layer (Aug 25–27).** Agent registration (custodial + client-side key paths), full mandate chain, caps, idempotency, price-hash pinning, structured refusals. Unit + integration tests.
**Check:** three scripted attacks all refused with machine-readable reasons and audit entries: over-cap purchase; replayed payment mandate (no second charge); tampered cart (price-hash mismatch).

**M3 — Audit-trail viewer (Aug 28).** React timeline replaying any purchase: mandates, verifications, refusals, payment events, human-readable "why allowed/refused" lines.
**Check:** the M2 refusals and one happy purchase each render as a complete, self-explanatory timeline at a public URL.

**M4 — Ingestion + dataset (Aug 29–31).** Demo dataset built (§5.3); ingestion pipeline with per-field confidence; merchant confirmation screen; accuracy measured.
**Check:** ingesting the 25–30 raw products yields a published catalog where every low-confidence field went through confirmation, and accuracy vs hand labels ≥ the floor set by S3, reported per field.
**→ Aug 31 checkpoint: if ≥2 days behind, fire the §9 de-scope ladder now, not later.**

**M5 — Rehearsed failures + WhatsApp secondary (Sep 1).** Both §5.6 failures scripted and repeatable. WhatsApp price-list ingestion only if the checkpoint passed.
**Check:** one command each produces the full failure timeline in the viewer; the oversell refund is visible in the Razorpay test dashboard.

**M6 — Eval harness (Sep 1–2).** The 30 protocol scenarios + rule-auditor + 3–5 live runs + scoreboard.
**Check:** `npm run evals` completes in one command; auditor reports zero violations from the audit log alone; scoreboard lands in the README.

**M7 — Release (Sep 2–3).** Demo video recorded, README finalized, architecture doc, repo public.
**Check:** repo public with live demo URL working; video published; release notes in `private/` completed.

**Buffer (Sep 4–5):** absorbs slips only. If empty: second merchant, upsell tool, polish.

---

## 9. Kill criteria & de-scope ladder

**Kill criteria (written now so momentum can't renegotiate them):**
- **K1:** M1 not green by **EOD Aug 25** → cut the REST twin (MCP only, keep the discovery doc). Still not green by **EOD Aug 26** → abandon Render, fall back to an ngrok public HTTPS tunnel (still connector-compatible) or a Claude Code local demo; log the decision.
- **K2:** S3 extraction spike < ~70% name+price exact-match on gpt-5-mini **and** gpt-5 → WhatsApp text becomes the primary ingestion format; photos+captions become stretch.
- **K3:** Any milestone runs > 2× its estimate → stop, fire the next rung of the ladder before continuing.

**De-scope ladder (first to die → last):**
1. Upsell tool (already stretch)
2. WhatsApp secondary format
3. Second demo merchant
4. Interactive audit viewer → server-rendered static timeline (the *content* survives)
5. ACP REST twin (discovery doc survives)
6. Eval scenarios 30 → 15 (rule-auditor NEVER dies)

**Never cut:** mandate chain · rule-auditor · rehearsed failures · deployed demo (unless K1 fires).

---

## 10. Cut list (v1 does NOT do — say so in the README)

- Real UAP/AP2 compliance claims — re-enter: never (no public UAP spec exists).
- Magic Checkout / Turbo UPI — re-enter: never for this build (require merchant onboarding; Standard Checkout/Orders/Links is the honest surface).
- Multi-merchant marketplace discovery — re-enter: post-v1 if pursued further.
- Real payments — re-enter: never.
- Merchant analytics dashboard — re-enter: never for v1.
- Transport-layer auth (OAuth/static headers) — re-enter: post-v1 hardening; identity is in-protocol for v1 (§5.2).
- ONDC schema — re-enter: never for v1.

The README carries a "what this doesn't do and why" section.

---

## 11. Risks

- **Razorpay test mode surprises (S1)** — consequence: M1 slips, everything cascades — trigger: any S1 step failing on Day 1 → act same day (K1 path).
- **claude.ai connector friction (S2)** — consequence: demo topology changes — trigger: connector won't attach to the Render URL → fall back to Claude Code as the demo client, say so in the video.
- **Free-account quota during takes** — consequence: demo retakes blocked — mitigation: all iteration through Claude Code (Max); the free account is touched only for final rehearsed takes.
- **Render free-tier cold starts** — consequence: sluggish first tool call in a demo or judge visit — mitigation: ping workflow + manual warm-up before any take.
- **Two-agent demo fragility** — consequence: flaky video takes — mitigation: script the happy path tightly, record in segments, keep both failure cases fully scripted.
- **Extraction under-delivers (S3/K2)** — consequence: headline feature weakens — trigger: accuracy floor missed after model step-up → flip formats per K2 and report honest numbers anyway.
- **"Grading own homework"** — consequence: metrics get discounted — preempt: publish hand labels; auditor reads only the audit log; methodology states stub vs real-rail split.

---

## 12. Sources (trimmed to load-bearing)

- https://razorpay.com/docs/mcp-server/ · https://razorpay.com/docs/payments/payments/test-upi-details/ · https://razorpay.com/docs/webhooks/ · https://razorpay.com/docs/api/refunds/ · https://razorpay.com/docs/payments/dashboard/test-live-modes/
- https://razorpay.com/blog/agentic-payments-the-future-of-in-app-commerce/ · https://razorpay.com/agentic-payments/
- https://ap2-protocol.org/ · https://github.com/agentic-commerce-protocol/agentic-commerce-protocol
- claude.ai custom connectors: https://support.claude.com/en/articles/11175166 · https://claude.com/docs/connectors/building/authentication
- UAP reporting: business-standard.com (126070801343) · outlookbusiness.com (unified-agent-protocol)
- Full research trail: `private/research-archive.md` (local only).
