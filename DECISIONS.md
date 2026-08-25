# Decision log — append-only. Entries are superseded, never edited.

## 2026-08-21: Build merchant-side agentic-commerce infrastructure on Razorpay test rails
Why: India's agentic-payment rails (UPI Reserve Pay, MCP-based checkout pilots, reported UAP) are ahead of its long-tail merchants; the merchant-side stack is the unshipped piece. Maximum alignment with the live protocol ecosystem (MCP, AP2 vocabulary, ACP-flavored REST).
Rejected: revenue-recovery sequencer (mature commercial solutions already exist); transaction-risk scoring (uncompetitive against foundation-model-scale incumbents); reconciliation tooling (well-served market, lowest novelty).
Revisit when: never for v1; alternative-direction notes preserved in private/research-archive.md.
Tier: Likely (research-backed, Aug 2026 sources)

## 2026-08-22: TypeScript end-to-end (Node 22, Express, MCP TS SDK, Razorpay Node SDK, React/Vite)
Why: one language across storefront, agents, evals, and UI; the official SDKs for every piece of this build are TypeScript-first.
Rejected: Python/FastAPI backend (splits the codebase or loses MCP TS SDK maturity); Python everything (weakest audit-viewer UI story).
Revisit when: never within this build.
Tier: Verified (user decision, 2026-08-22)

## 2026-08-22: Deploy from day 1 on Render; Postgres, not SQLite
Why: webhooks need a public URL, claude.ai custom connectors need a remote HTTPS MCP endpoint reachable from Anthropic's cloud, and the demo must be hittable live; Render's ephemeral filesystem rules out SQLite for a durable audit log.
Rejected: localhost + ngrok (fragile demo — kept as K1 fallback); deploy-at-the-end (deployment surprises land when there's no slack).
Revisit when: kill criterion K1 fires (M1 not green by EOD Aug 26).
Tier: Verified (user decision, 2026-08-22)

## 2026-08-22: Ingestion v1 = Instagram-style photos+captions primary; WhatsApp price-list secondary, gated on the Aug 31 checkpoint
Why: multimodal ingestion is the headline demo moment; WhatsApp text is the cheap second format and the K2 fallback.
Rejected: photos-only (loses the fallback); WhatsApp-only (loses the visual wow).
Revisit when: spike S3 shows <~70% name+price exact-match after model step-up → formats flip (K2).
Tier: Verified (user decision, 2026-08-22)

## 2026-08-22: Project/repo name = agent-store
Why: user's pick; matches the existing repo directory.
Rejected: AgentDukaan, Dukaan2Agent, MandiGate, "Agent Storefront".
Revisit when: never.
Tier: Verified (user decision, 2026-08-22)

## 2026-08-22: Eval harness is hybrid — 30 scripted protocol-level scenarios + 3–5 live Claude-as-buyer runs
Why: scripted scenarios give deterministic, one-command, honest metrics; a real-LLM-driven batch of 30 is slow, flaky, and makes pass rates non-reproducible. Live runs still prove the end-to-end story.
Rejected: all-LLM batch (non-deterministic scoreboard); all-scripted (no proof a real agent completes the flow).
Revisit when: never within this build.
Tier: Verified (user decision, 2026-08-22)

## 2026-08-22: Demo merchant = D2C streetwear brand, ~25–30 products, published hand-labeled ground truth
Why: visual vertical with real variants (size/color); published labels preempt "grading your own homework."
Rejected: food/bakery as primary (weaker variant story — kept as buffer-time second merchant).
Revisit when: buffer time exists after M7.
Tier: Likely (declared to user 2026-08-22)

---

# Design-review round (2026-08-22, post-grilling)

## 2026-08-22: Payment completion — human consent tap for the live demo; gateway stub + Playwright payer for evals
Why: verified fact — plain Razorpay test accounts have NO API-only payment completion (S2S is support-gated); the hosted checkout/link page is the only path. The human approving the link is framed as the consent step (mirrors UPI Reserve Pay's authorization/agent-action split). Scripted evals stay deterministic via an injected gateway stub; only the real-rail subset uses a Playwright payer-bot.
Rejected: undocumented `payments/create/ajax` endpoint (unsupported, fragile); all-real-rails evals (slow, flaky, not CI-runnable).
Revisit when: never within this build.
Tier: Verified (user decision, 2026-08-22; API facts verified against Razorpay docs)

## 2026-08-22: Two rehearsed failures, each internally coherent
Why: the original "decline → retry → refund" story was incoherent — a declined payment has nothing to refund. Split: (1) decline → one bounded retry → fail closed, zero charge; (2) payment captured → oversell at fulfillment → automatic API refund.
Rejected: one contrived combined story; dropping the refund from the headline demo.
Revisit when: severe time pressure → keep only failure (1).
Tier: Verified (user decision, 2026-08-22)

## 2026-08-22: Split key custody
Why: a claude.ai connector client cannot hold a private key or compute signatures — every tool executes server-side. Custodial-only would mean the server signs both sides of its own mandate chain. Split model: connector buyers get custodial server-held keypairs (the PSP/wallet custody model); the Agent SDK eval buyer holds its key client-side and signs locally, proving the protocol supports non-custodial signing.
Rejected: custodial-only (weakens the signature story); client-side-only (kills the claude.ai demo).
Revisit when: never within this build. Document the custody model explicitly in the architecture doc.
Tier: Verified (user decision, 2026-08-22)

## 2026-08-22: Authless MCP transport; identity lives in the protocol
Why: static-header auth on claude.ai custom connectors is beta-gated (cannot rely on access); OAuth+DCR costs 1–2 days and proves nothing this project is about. `register_agent` issues an agent token passed as a tool argument; mandate chain + caps are the actual security layer. Transport auth documented as deployment-specific hardening, out of scope for v1.
Rejected: OAuth 2.0 + dynamic client registration (time tax); static API-key headers (beta-gated); query-param tokens (prohibited by MCP auth spec).
Revisit when: post-v1 hardening.
Tier: Verified (user decision, 2026-08-22; connector auth facts verified against Anthropic docs)

## 2026-08-22: Neon Postgres + Render free web service + GitHub Actions keep-alive — supersedes "Render Postgres" above
Why: Render free Postgres is deleted ~30 days after creation (would die ~Sep 21); Neon's free tier has no expiry and first-class Drizzle support. Render free web service stays for the public URL; a GitHub Actions scheduled ping (every 10 min) prevents idle spin-down. Render's own cron jobs are a paid service type.
Rejected: Render free Postgres (30-day cliff); paid Render Postgres (unnecessary spend); UptimeRobot (workflow-in-repo preferred).
Revisit when: never within this build.
Tier: Verified (user decision, 2026-08-22; Neon/Render facts Likely)

## 2026-08-22: Extraction on gpt-5-mini — supersedes "claude-sonnet-5" extraction
Why: preserve the ~$4 Anthropic API credit reserve; user holds an all-models OpenAI key. gpt-5-mini default behind a one-line-swappable interface; S3 gate steps up to gpt-5 before K2 fires. Ingestion simplifies to a plain TS pipeline (no agent framework).
Rejected: claude-sonnet-5 (burns the only Anthropic credits); stealth/preview models via OpenRouter/Nous (unnamed pre-release models poison a reproducibility-focused eval story — never).
Revisit when: S3 spike results.
Tier: Verified (user decision, 2026-08-22)

## 2026-08-22: Model/credit routing — iterate on Claude Code (Max), measure on Agent SDK (Max auth), API credits are reserve
Why: user's Claude Code rides a Max subscription (not usable on web claude.ai — free account there). All buyer-flow iteration through Claude Code costs no API credits; the Agent SDK live runs ride the same Max auth; ~$4 API credits held as emergency reserve only. Hero demo client: claude.ai free-account custom connector (free plan supports exactly one — verified); Claude Code is the fallback demo client.
Rejected: burning API credits on iteration; buying Pro/Max for web.
Revisit when: free-account quota blocks final takes → record demo through Claude Code instead.
Tier: Verified (user decision, 2026-08-22)

## 2026-08-22: Dataset images via gpt-image-1; captions hand-written
Why: product shots are generatable; caption messiness (Hinglish, emoji, broken price formats) IS the test payload — generated captions would be suspiciously clean.
Rejected: generated captions; stock-photo sourcing (licensing friction).
Revisit when: never within this build.
Tier: Verified (user decision, 2026-08-22)

## 2026-08-24: Railway (always-on) is the primary deployment; Render free stays as the K1 fallback — supersedes the Render deployment decision above
Why: Render's free web service spins down after ~15 minutes idle, so the first tool call from a judge or a claude.ai connector pays a cold start. The GitHub Actions keep-warm ping mitigates but does not eliminate this — scheduled workflows are themselves delayed under load. Railway does not sleep. Railway has no free tier, but its $5 one-time trial credit (valid 30 days) covers the entire demo window (ship Sep 2–3) at zero cost; after that it is $5/mo Hobby or services pause. Render free stays deployed and configured at no cost as the K1 fallback demo path, so the kill criterion keeps a live target.
Deployed URLs: Railway `https://agent-store-production-8345.up.railway.app` (primary, Razorpay webhook points here); Render `https://agent-store-e4ka.onrender.com` (fallback).
Rejected: Render Starter ($7/mo — dearer than Railway Hobby and still paid); staying on Render free (cold start sits in the demo path); Fly.io (migration cost, no clear win over Railway).
Revisit when: the trial credit runs out — either pay $5/mo Hobby or fall back to Render free + ping.
Tier: Verified (user decision, 2026-08-24)

---

# Domain-model grilling round (2026-08-23) — vocabulary now canonical in CONTEXT.md

## 2026-08-23: An Agent is its registration — no stable buyer identity in v1
Why: nothing exists to anchor identity to (authless transport, no OAuth, no verified registry). Re-registration mints a new Agent with a fresh cap; Sybil cap-bypass is documented as a v1 non-goal — the gap a UAP-style verified registry would close, which is the point the project illustrates. Full reasoning: docs/adr/0001.
Rejected: stable external identifier at registration (nothing trustworthy to bind it to).
Revisit when: post-v1 hardening / any real UAP spec.
Tier: Verified (user decision, 2026-08-23)

## 2026-08-23: "Order" = our domain entity; the Razorpay object is always "gateway order"
Why: two entities were sharing one word across §5.1/M1. The audit log and rule-auditor speak only in domain Orders; code says `gatewayOrderId`, never a bare `orderId` for the Razorpay object. Docs updated to reflect the split.
Rejected: contextual disambiguation ("it's obvious from context" — it wasn't).
Revisit when: never.
Tier: Verified (user decision, 2026-08-23)

## 2026-08-23: No stored cart — `create_cart` is one-shot and returns the immutable Cart mandate
Why: the LLM buyer holds its own draft; the mandate chain wants one immutable signed artifact; kills cart-lifecycle state days before deadline. Full reasoning: docs/adr/0002.
Rejected: mutable server-side draft cart with add/remove tools (state and expiry semantics that buy nothing).
Revisit when: never within this build.
Tier: Verified (user decision, 2026-08-23)

## 2026-08-23: Variant is the sellable unit
Why: streetwear means size/color; stock, price, cart lines, and oversell checks reference a Variant ID. Product is a display/search grouping; ingestion defaults all variants of a captioned product to the caption's single price; products without stated variants get one implicit default variant so checkout never branches on "has variants?".
Rejected: product-level stock/price with variant as an attribute (breaks oversell and cart-line precision).
Revisit when: never within this build.
Tier: Verified (user decision, 2026-08-23)

## 2026-08-23: Two enforced spend limits — Budget (per Intent) and Cap (per Agent×Merchant)
Why: Cap is declared by the buyer at registration (self-imposed, Reserve-Pay-style) and immutable for that registration's lifetime; Budget is declared in the Intent mandate. Both are enforced at mandate verification, each with its own refusal code (`OVER_BUDGET`, `OVER_CAP`) — two named refusals make eval scenarios crisper.
Rejected: budget as recorded-but-unenforced intent; merchant-set caps (wrong party — Reserve Pay's model is the payer limiting their own agent).
Revisit when: never within this build.
Tier: Verified (user decision, 2026-08-23)

## 2026-08-23: Merchant is a first-class entity; no merchant-scoped routing in v1
Why: Merchant is a real row (ID, signing key, name) and everything foreign-keys to it — honest multi-merchant vocabulary — but one deployment serves one merchant with `merchantId` as config. No `/m/:merchantId/` URL space; marketplace routing is already on the cut list.
Rejected: implicit single-merchant schema (repaints every table later); full multi-merchant routing (marketplace scope creep).
Revisit when: post-v1 if a second merchant outgrows the buffer-time demo.
Tier: Verified (user decision, 2026-08-23)

## 2026-08-23: Refusal / Decline / validation error are three distinct words
Why: Refusal = trust layer says no on policy, before money moves, always with `{code, reason, recoverable}`. Decline = gateway says no after the trust layer said yes. Malformed input is a plain validation error. The rule-auditor's "every refusal has a reason code" is only checkable if Refusal is the narrow term.
Rejected: "refusal" as umbrella for any system no.
Revisit when: never.
Tier: Verified (user decision, 2026-08-23)

## 2026-08-23: Confidence gates publishing at product level; high-confidence fields auto-publish
Why: fields at/above threshold publish without merchant action; any below-threshold field holds the whole Product in `needs-confirmation` (lifecycle `draft → needs-confirmation → published`). Field-level publishing would allow half-visible products — an agent could cart an item whose price was never confirmed.
Rejected: every-field-confirmed (merchant burden, kills the auto-publish story); field-level publishing (half-visible products).
Revisit when: never within this build.
Tier: Verified (user decision, 2026-08-23)

## 2026-08-23: Cart mandates coexist freely; Intent mandates are consumed once (chain is 1:1:1)
Why: no invalidation and no TTL keeps the no-stored-cart model pure (safety = payment-time verification). Stress-testing found one hole — N carts under one Intent could each pass a per-cart budget check while cumulatively exceeding the Budget — closed by intent consumption: first paid Cart mandate consumes its Intent, later attempts refuse with `INTENT_CONSUMED`. A second purchase signs a new Intent (cheap for an LLM buyer). See ADR-0002.
Rejected: invalidate-previous-carts (re-introduces cart state); TTL (clock-dependent demo/eval failure mode for no real risk); cumulative-budget-per-intent (more bookkeeping, muddier auditor claim than 1:1:1).
Revisit when: never within this build.
Tier: Verified (user-delegated 2026-08-23: approved (a) conditional on the reasoning clearing; intent-consumption amendment adopted by Claude to close the budget hole — flagged for veto)

## 2026-08-23: No stock reservations; decrement at fulfillment, atomically
Why: the oversell rehearsed failure only exists because carting reserves nothing — stock is checked at payment-mandate verification and re-checked at fulfillment; the race window between them is deliberate. Decrement happens at the fulfillment-time check via atomic conditional update (`UPDATE ... SET stock = stock - qty WHERE stock >= qty`): row hit = fulfilled, miss = oversell → refund path. Decrementing at capture would make the oversell scenario unscriptable.
Rejected: cart-time reservation (kills the oversell demo); decrement-at-capture.
Revisit when: never within this build.
Tier: Verified (user decision, 2026-08-23)

## 2026-08-23: Idempotency keys are buyer-minted; reuse with a different cart hash refuses
Why: buyer-minted is the convention (SDK helper generates UUIDs); scoped Agent×Merchant. Same key + same cart hash → replay original result. Same key + different cart hash → refuse `IDEMPOTENCY_REUSE`, never silently return a result for a cart the buyer didn't submit. Free eval scenario.
Rejected: server-minted keys (buyer can't retry safely); silent replay on mismatched cart.
Revisit when: never.
Tier: Verified (user decision, 2026-08-23)

## 2026-08-23: Receipts are merchant-signed chain proofs; refunds produce a linked refund receipt
Why: Receipt = Order ID + all three mandate hashes + amount + gateway payment ID + timestamp, signed with the merchant key — a buyer can prove this chain led to this charge to a third party. The oversell path emits a signed refund receipt referencing the original: same signing code, completes the audit-viewer story for rehearsed failure #2.
Rejected: unsigned confirmation payload; refund as audit-entry-only.
Revisit when: never within this build.
Tier: Verified (user decision, 2026-08-23)

## 2026-08-23: Audit events commit atomically with state; the system is NOT event-sourced
Why: the rule-auditor's claim rests on log completeness — so every state transition writes its audit event in the same DB transaction (complete by construction), but state is not rebuilt from the log. Full reasoning: docs/adr/0003.
Rejected: fire-and-forget logging (audit theater); full event sourcing (projection/replay machinery a days-long build can't afford, proves nothing extra).
Revisit when: never within this build.
Tier: Verified (user decision, 2026-08-23)

## 2026-08-23: Money is integer paise, INR only
Why: floating-point money under an auditor asserting "no charge above cap" is self-sabotage; Razorpay's API is already paise-denominated, so zero impedance. No currency field except where gateway calls demand one.
Rejected: decimal strings; multi-currency schema.
Revisit when: never.
Tier: Verified (user decision, 2026-08-23)

## 2026-08-23: Stock is a required field — missing stock always blocks publishing
Why: captions almost never state quantities, and stock is where the oversell failure and cap math live — a defaulted number is fiction in exactly the field the rule-auditor reasons about. Merchant must fill stock at confirmation; in practice nearly every demo product therefore passes through the confirmation screen, which guarantees that screen appears in the demo.
Rejected: defaulted finite stock with a low-confidence flag (honest-numbers story poisoned).
Revisit when: never within this build.
Tier: Verified (user decision, 2026-08-23)

---

## 2026-08-22: Repo posture — reads as an infrastructure project; release logistics git-ignored
Why: the repository should stand as a real project on its own terms. All submission/release-specific material (form questions, deadline notes, video outline, research archive) lives in git-ignored `private/`.
Rejected: submission framing in PLAN.md/README (original rev 1 plan).
Revisit when: never.
Tier: Verified (user decision, 2026-08-22)

## 2026-08-26: Gateway stub is composed at test/eval composition points; no GATEWAY env switch
Why: T2's acceptance criterion "real-rail code paths use the real implementation unchanged" is a constraint, not a feature — the deployed server stays Razorpay-only (`src/index.ts` constructs `RazorpayGateway` unconditionally), and every consumer of the stub (the integration tests today, the T15 eval runner next) constructs `StubGateway` at its own composition root. Which gateway ran is a property of the code path, never of deployment state — so the deployed demo can never silently run fake rails.
Rejected: `GATEWAY=stub|razorpay` env switch (speculative config plumbing; makes Razorpay creds conditionally optional and adds a misconfiguration mode).
Revisit when: T15 turns out to need the deployed server itself running against the stub (nothing currently suggests it).
Tier: Likely (Claude ruling during T2, 2026-08-26 — flagged for veto; plan: docs/superpowers/plans/2026-08-26-t2-gateway-stub.md)

## 2026-08-26: In-process tests run on embedded PGlite with the real committed migrations
Why: T2's "happy-path purchase fully in-process with no network calls" needs a real Postgres without a socket. PGlite (WASM, devDependency only) runs the committed drizzle migrations — including 0001's append-only audit triggers — so integration tests exercise the same SQL, transactions, and trigger behavior as Neon. It stays out of the shipped build by construction: `src/testSupport/` is excluded from `tsconfig.build.json`, the PGlite instance is cast to the app's `Database` type exactly once (documented, in `src/testSupport/pgliteDatabase.ts`), and `dist/` is verified free of pglite.
Rejected: a Neon test database (network dependency, not CI-hermetic, fails the criterion); widening the production `Database` type to cover both drivers (prod type churn for a test concern); mocking drizzle (proves nothing about the audit-trigger claims).
Revisit when: a Neon-vs-PGlite behavior divergence surfaces (none known).
Tier: Likely (Claude ruling during T2, 2026-08-26 — flagged for veto; plan: docs/superpowers/plans/2026-08-26-t2-gateway-stub.md)

## 2026-08-26: Ed25519 via node:crypto — no @noble/ed25519
Why: PLAN §5 names `@noble/ed25519`, but Node has shipped Ed25519 natively (`generateKeyPairSync`/`sign`/`verify`) since v12 — the dependency would buy nothing and reopen the npm-10 lockfile trap (engineering-log 2026-08-24). The wire encoding is fixed once, in `src/domain/keys.ts`: base64 DER (SPKI public, PKCS8 private), base64 signatures — the T4 mandate chain and the eval buyer's client-side signer (DECISIONS 2026-08-23 "Split key custody") must use exactly this encoding.
Rejected: `@noble/ed25519` (PLAN.md §5; a new dependency proving nothing extra).
Revisit when: signing must run somewhere without node:crypto (a browser buyer) — nothing planned runs there.
Tier: Likely (Claude ruling during T3, 2026-08-26 — flagged for veto)

## 2026-08-26: Agent token stored plaintext; get_product stays open, commerce tools gated
Why: two T3 design calls. (1) The Agent row already holds the custodial private key — custody *is* the design (ADR-0001) — so hashing the bearer token at rest would protect one secret sitting beside an unprotected one; it is stored plaintext and looked up by unique index. Refusal audit payloads record only that a token was presented, never the token. (2) `get_product` requires no token: a shop window is public, and registration gates transacting — `checkout` and `get_order_status` refuse `UNREGISTERED_AGENT` (with an `agent.refused` audit entry) without a valid one, which is where PLAN §10's unregistered-agent eval scenario lands.
Rejected: SHA-256 token-at-rest (theater next to the stored private key); gating `get_product` (blinds unregistered buyers for zero trust win — the refusal must protect money, not the catalog).
Revisit when: keys leave custody (post-v1 UAP direction) — then the token is the only secret and hashing earns its keep.
Tier: Likely (Claude ruling during T3, 2026-08-26 — flagged for veto)

## 2026-08-26: The mandate chain is the only purchase path — `checkout` is replaced by declare_intent / create_cart / submit_payment
Why: the rule-auditor's headline claim — no charge without a complete verified mandate chain — is global, and a surviving tokens-only `checkout` tool would be a standing exception to it. The T1 walking-skeleton tool is deleted, not deprecated: the three-step chain (Intent → Cart → Payment) is now the one door money can move through, each tool gated by `requireRegisteredAgent` and mapped through the single `withToolErrors` seam. `checkout.ts` keeps its four-phase shape with the trust gate filled in at phase 3, strictly before the Order insert and before any gateway contact.
Rejected: keeping plain `checkout` beside the mandate tools (two money paths, auditor claim becomes "no charge *usually*"); folding the whole chain into one mega-tool (loses the per-step signatures and the buyer's ability to re-cart on PRICE_CHANGED).
Revisit when: never within this build.
Tier: Likely (Claude ruling during T4, 2026-08-26 — flagged for veto)

## 2026-08-26: Orders carry line items in `order_items`; the legacy single-variant columns are frozen
Why: a Cart mandate carries Variant-level items (plural, per spec), and the T15 out-of-stock-mid-cart scenarios need real multi-item carts. New Orders write `order_items` rows plus `orders.agent_id`; `orders.variant_id` / `quantity` / `unit_price_paise` are never written again and stay only for pre-T4 rows. `orders.amount_paise` remains the authoritative total either way.
Rejected: restricting Cart mandates to one Variant (falsifies the spec's item list and the eval scenarios); rewriting pre-T4 rows into `order_items` (a backfill that proves nothing and risks the audit story).
Revisit when: never within this build.
Tier: Likely (Claude ruling during T4, 2026-08-26 — flagged for veto)

## 2026-08-26: Mandate error taxonomy — bad reference is a validation error, bad substance is a Refusal
Why: keeps CONTEXT.md's failure vocabulary sharp at the new seam. A hash that names nothing (or another Agent's mandate) is malformed input → `ValidationError` (`INTENT_NOT_FOUND` / `CART_NOT_FOUND`, alongside new `INVALID_BUDGET`/`INVALID_WANT`/`INVALID_CART_ITEMS`). A mandate that exists but fails signature, chain-hash, or total verification is policy → `Refusal INVALID_MANDATE`, recoverable false. A pinned price hash that no longer matches the live catalog → `Refusal PRICE_CHANGED`, recoverable true — the buyer re-runs create_cart. Stock shortfall at payment stays `OUT_OF_STOCK`. Every submit_payment Refusal writes a `payment.refused` audit event (own transaction, orderId null — the `agent.refused` precedent) before throwing.
Rejected: refusing on unknown hashes (would let a typo probe the policy layer and muddy "every Refusal has a reason code"); validation-erroring on tampered signatures (hides tampering from the audit log entirely).
Revisit when: never within this build.
Tier: Likely (Claude ruling during T4, 2026-08-26 — flagged for veto)

## 2026-08-26: Receipts mint inside the paid-webhook transaction, only for mandate-backed Orders; buyers fetch them via get_order_status
Why: the webhook is the moment payment becomes fact, and the one-way `UPDATE … WHERE status <> 'paid'` guard already makes that transition exactly-once under Razorpay's near-simultaneous triple deliveries — minting in the same transaction, after that guard, makes the Receipt exactly-once for free (the `already_paid` branch returns before it). Pre-T4 Orders have no chain to attest, so they get no Receipt. A missing merchant signing key at webhook time records `order.anomaly_detected` (`missing_merchant_signing_key`) and still returns 200 — redelivery would fix nothing, and the paid transition stands. Retrieval: the webhook is async, so `get_order_status` returns `receipt: {payload, signature, merchantPublicKey}` once paid — the public key rides along because no other endpoint publishes it yet, and "independently verifiable" is only honest if the verifier can actually get the key.
Rejected: minting at submit_payment (would attest a payment that hasn't happened); a separate get_receipt tool (one more round-trip for no isolation win); throwing on a missing key (turns a provisioning gap into an infinite redelivery loop).
Revisit when: a /.well-known-style key endpoint lands (then the inline key becomes a convenience, not the source).
Tier: Likely (Claude ruling during T4, 2026-08-26 — flagged for veto)

## 2026-08-26: T5 enforcement is a commented slot; T4 persists everything it will need
Why: OVER_BUDGET, OVER_CAP, INTENT_CONSUMED and IDEMPOTENCY_REUSE are T5's suites (issue #6), but retrofitting their data later would mean schema churn mid-demo-week. So T4 stores Budget on the intent row, `orders.agent_id` for cumulative Cap math, `consumed_by_order_id` (always NULL in T4) for intent consumption, and a unique `(agent_id, idempotency_key)` index — and `submit_payment` carries one clearly-commented slot, after chain verification and before the Order insert, where those checks land. Additive enforcement, zero migration.
Rejected: enforcing early (blows T4's review scope and duplicates T5's acceptance tests); persisting nothing (T5 would reopen every table T4 just shipped).
Revisit when: T5 lands (the slot comment is deleted by the code that fills it).
Tier: Likely (Claude ruling during T4, 2026-08-26 — flagged for veto)
