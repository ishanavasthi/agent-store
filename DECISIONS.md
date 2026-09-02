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

## 2026-08-26: T5 landed — the slot is deleted; deterministic check order, replay is an audit event
Why: `submit_payment`'s trust gate now enforces issue #6, in a fixed order so every eval scenario meets exactly one code. Idempotency is checked first — a same-key + same-cart retry replays the original result even if the catalog moved since (the buyer is asking about a submission that already happened, so PRICE_CHANGED etc. must not answer for a new one); same key + different cart refuses `IDEMPOTENCY_REUSE` (recoverable — mint a fresh key). Then chain verification, an `INTENT_CONSUMED` pre-check (recoverable — a second purchase signs a new Intent), PRICE_CHANGED/OUT_OF_STOCK, and `OVER_BUDGET` against the *signed* Intent payload's `budgetPaise`, not the denormalized column (recoverable — a smaller cart under the same Intent can pass). `OVER_CAP` and intent consumption run inside the order-insert transaction: cumulative spend counts captured AND pending (only cancelled/refunded free headroom), and over-Cap is not recoverable — the Cap is immutable for the registration's lifetime. Any transactional refusal rolls back every insert, so a refusal never persists a payment_mandates row and never consumes an idempotency key. Replays audit as the new `payment.replayed` event (migration 0004 grows the enum), attributed to the original Order; the unique `(agent_id, idempotency_key)` index remains only as the race backstop, mapped to replay/`IDEMPOTENCY_REUSE` rather than surfacing as a raw index error.
Rejected: Budget from the denormalized `budget_paise` column (the signed artifact is what the Agent authorized); counting only captured spend toward the Cap (a burst of pending orders could sail past the ceiling before webhooks land); resuming a half-finished checkout on replay when the original crashed before link issuance (not T5 scope — a plain loud error, never a second gateway call under a replaying key).
Revisit when: never within this build.
Tier: Likely (Claude ruling during T5, 2026-08-26 — flagged for veto)

## 2026-08-26: T6 landed — client custody is `private_key IS NULL`; the Cart signature is deferred to submit_payment
Why: the client-custody half of split custody (2026-08-22 "Split key custody") ships as protocol arguments on the *same* tools, not a parallel surface. `register_agent` takes an optional client `publicKey` (validated as a usable Ed25519 SPKI DER key — garbage is `INVALID_PUBLIC_KEY`); the row then stores no private key, and that NULL is the entire custody model. Intent and Payment mandates are composed and signed client-side (the client mints `createdAt`; the server recomposes the payload from the token's own identity fields and verifies the supplied signature — sign different fields and verification simply fails). The Cart is composed server-side by necessity (pinned prices, priceHash, createdAt), so `create_cart` stays one-shot per ADR-0002: it stores `agent_signature` NULL, and the buyer's signature over the returned payload arrives with `submit_payment` as `cartSignature`, is verified at the trust gate with the rest of the chain, and is persisted NULL → value in the order transaction — the one sanctioned write to a mandate row's signatures. An unverifiable client signature is `Refusal INVALID_MANDATE` (not recoverable), audited as `mandate.refused` at declare_intent / `payment.refused` at submit_payment; custody-contradicting arguments are `CUSTODY_MISMATCH` validation errors in both directions. The scripted SDK buyer (`src/buyer/`: `LocalSigner` + `runSdkBuyerPurchase`) drives the whole flow and re-verifies every hash and the Receipt independently; T16's live runs ride the same machinery. Full reasoning: docs/adr/0004.
Rejected: a two-step create_cart handshake (reintroduces the half-created cart ADR-0002 killed); skipping the agent-side Cart signature because the Payment signature covers cartHash (hash-transitivity is not a signature); a custody flag column (could disagree with the NULL that is the fact); extending the server to sign "just this once" for a client-custody Agent (the design error the model exists to make impossible).
Revisit when: never within this build.
Tier: Likely (Claude ruling during T6, 2026-08-26 — flagged for veto)

## 2026-08-26: Standalone Refusals are addressed by audit `seq`; context rejoins through the hashes their payloads already carry
Why: a Refusal is precisely the case where no Order exists, so the T7 viewer needs another address for it — and `seq` is already unique, monotonic, and public in every `/audit` response. `GET /audit/refusals/:seq` names one Refusal; its purchase-attempt timeline is recovered by matching the `intentHash`/`cartHash` a `payment.refused` payload already records against the `mandate.intent_declared` / `mandate.cart_created` events (plus sibling refusals sharing the `intentHash`) — the same linkage trick `readPurchaseAuditChain` uses. `agent.refused` / `mandate.refused` carry no hashes because they fired before any chain existed, so their single event IS the complete story. No new columns, no synthetic attempt id: the log stays append-only exactly as ADR-0003 shipped it.
Rejected: an attempt-id column (a write-path schema change to an append-only table, for a read concern); addressing refusals by `intentHash` (not unique — sibling refusals share it — and absent on the hashless refusal types).
Revisit when: never within this build.
Tier: Likely (Claude ruling during T7, 2026-08-26 — flagged for veto)

## 2026-08-26: T12 ingestion — Variant stock comes only from stated counts; a stated total with no split holds the Product
Why: the schema stores stock per Variant (checkout and the oversell decrement read `variants.stock`), but captions state counts three ways — a product-level count with no variants ("25 pcs ready" → the implicit default Variant carries 25), per-variant counts ("S: 4 | M: 7 | L: 2" → each Variant carries its own, and the Product can publish even though *product-level* stock was never stated), and a total across variants ("30 pcs total dono colour mila ke") which is real information but not a per-variant number: any split we invent goes straight into the column the oversell check enforces. So `variants.stock` (and `pricePaise`) became nullable, null meaning honestly-unknown; a Product publishes only when every Variant's stock is a stated count, and the unsplit total is kept in the `products.extraction` jsonb record for T13's confirmation screen to prefill. Same argument for the auto-publish threshold: 0.90, tuned on the committed run's threshold sweep (`fixtures/demo-dataset/runs/gpt-5-mini.json`) with deliberate margin over the minimal zero-wrong point, because earlier prompt iterations produced wrong names claiming 0.95 — the S3 "confidences are uncalibrated" caveat observed in the wild. Consequence accepted: only 3 of 28 demo items auto-publish; the other 25 hold in `needs-confirmation`, which is the demo behaviour PLAN §4 wanted anyway ("conveniently guarantees the confirmation screen appears").
Rejected: splitting a stated total evenly across Variants (fiction in the exact numbers money trusts); a sentinel stock of 0 with NOT NULL kept (0 means "sold out", a different fact from "unknown"); gating stock at product level only (would hold the fully-per-variant-counted MACHLI case forever, and would let a total-only product publish Variants with invented rows).
Revisit when: T13 lands, if the confirmation screen wants a different prefill shape from `products.extraction`.
Tier: Likely (Claude ruling during T12, 2026-08-26 — flagged for veto)
## 2026-08-26: T13 landed — Confirmation is a complete-final-state submission; the desk lives in the T7 SPA; no audit event
Why: four calls, one screen. (1) **The submission is the Product's complete final state** — title, description, and every Variant with an explicit price and stock — validated server-side (`domain/confirmation.ts`) and applied with the publish in one transaction, the status guard in the UPDATE's WHERE clause (the house exactly-once pattern). This is what makes "nothing unconfirmed is ever published" a *server* property rather than UI discipline: a held field is a missing value, and a missing value does not parse — there is no per-field patch endpoint through which an unconfirmed field could ride along. Field-level UX (flagging what fell below threshold, prefilling the unsplit total) is presentation over the same one contract. (2) **The confirmation desk is two new routes inside the T7 viewer SPA** (`/viewer/confirm`, `/viewer/confirm/:productId`) with its API at `/merchant/confirmations*` — zero new build, serve, or deploy infrastructure, per PLAN §3's "React SPA served by the same Express app for audit viewer + merchant confirmation" (singular SPA read literally). (3) **Variant reshaping is allowed at confirmation and only there**: a held Product was never `published`, so no Cart mandate or order line can reference its Variants — deleting the S3-style phantom rows ("one size fits all" / "beige") is correcting fiction, not rewriting history; submitted rows with a `variantId` update, rows without one insert, omitted rows delete. (4) **No audit event, and merchant errors are ValidationErrors, never Refusals**: T12's ingestion writes no catalog-lifecycle audit events (the log is the money ledger the rule-auditor reads, ADR-0003's scope), so the publish transition stays consistent with the transition that created the row; provenance lives instead in a `ConfirmationStamp` written into `products.extraction` in the publish transaction — "what the model said" and "what the merchant answered", side by side. A Refusal is the trust layer telling a *buyer* no on the money path (CONTEXT.md), and no buyer is near this seam — new codes `PRODUCT_NOT_FOUND` (404) / `PRODUCT_NOT_CONFIRMABLE` (409) / `INVALID_CONFIRMATION` (400). The endpoints are authless like every other surface: v1 has no merchant login, and transport auth is the same post-v1 hardening it is for the MCP face.
Rejected: per-field confirm endpoints (reopens half-confirmed products — the exact failure mode the product-level gate exists to prevent); a sibling SPA or server-rendered form (new infrastructure for the same screen); a `product.published` audit event (grows the rule-auditor's enum with a non-money transition T12 deliberately never wrote); merchant-side Refusals (would blur the failure vocabulary the auditor's guarantees hang on); blocking variant deletion (would leave phantom Variants forever sellable once published).
Revisit when: a merchant login exists (then `/merchant/*` gains auth with it); or post-publish editing is ever wanted (today `published` is terminal for this screen — re-editing means a new ticket, not a loosened guard).
Tier: Likely (Claude ruling during T13, 2026-08-26 — flagged for veto)

## 2026-08-26: T8 landed — the payment-attempt bound lives on the Order row; two distinct declines fail closed
Why: PLAN §5.6 failure 1 needs "exactly one bounded retry", and the bound has to survive redelivery, concurrency, and ADR-0003's rule that state is never rebuilt from the audit log. So the Order row itself carries `declined_gateway_payment_ids` — the set of *distinct* failed gateway payment ids — and an attempt is counted by an `UPDATE` whose WHERE clause holds both the membership check and the payable-status guard (the house exactly-once pattern): a redelivered `payment.failed` is free, a failure with no payment id is recorded but never counted (it cannot be deduplicated), and `cardinality(array)` IS the attempt count with no second source of truth. Attempt 1 audits `payment.declined` and leaves the Order `awaiting_payment` (the human may retry the same hosted link once); attempt 2 cancels in the same transaction — `status = 'cancelled'`, `cancelled_at`, and a structured `DeclinePayload` (`{kind: 'decline', code: 'PAYMENT_DECLINED', reason, attempts, gatewayErrorCode, gatewayErrorDescription}`, deliberately shaped unlike a Refusal: no `recoverable`) stored in `cancellation_reason`, plus `payment.declined` + `order.cancelled` audit events (migration 0006 grows the enum). The buyer is notified where buyers already look: `get_order_status` returns the stored Decline verbatim on a cancelled Order. Fail-closed is also one-way: `cancelled` is excluded from the paid transition's WHERE clause, so a capture landing after cancellation records `order.anomaly_detected` (`payment_after_cancellation`) instead of silently paying an Order whose buyer was told "zero charge". Cancellation frees Cap headroom automatically — the T5 cumulative sum already excludes cancelled. One command reproduces the whole sequence deterministically: `npm run failure:decline` (stub gateway + embedded PGlite, prints the audit timeline, asserts the outcome, exits non-zero if any guarantee fails).
Rejected: counting attempts from `payment.declined` audit rows (rebuilds state from the log, ADR-0003); a bare `declined_attempts` counter (double-counts redelivered webhooks — the id set is the counter and the dedupe in one column); auto-issuing a fresh payment link on decline (the retry is the human's consent to try again, not the merchant's to presume); letting a late capture pay a cancelled Order (contradicts what the buyer was already told; a human resolves it via the anomaly).
Revisit when: ~~T9's refund path lands, if a late capture on a cancelled Order should auto-refund instead of parking as an anomaly.~~ Revisited at T9 — the anomaly stays parked; see "2026-08-26: T9 landed" below.
Tier: Likely (Claude ruling during T8, 2026-08-26 — flagged for veto)

## 2026-08-26: T9 landed — fulfilment decrements atomically in the paid transaction; an Oversell auto-refunds with a linked refund receipt
Why: PLAN §5.2's prescription implemented literally. Fulfilment runs inside `applyGatewayWebhook`'s paid transaction, only on the delivery that won the one-way paid UPDATE (so Razorpay's sibling webhooks can never double-decrement), and each line is the atomic conditional `UPDATE variants SET stock = stock - qty WHERE stock >= qty` — the decrement IS the check, never check-then-write. A hit on every line audits `order.fulfilled`; any miss is the Oversell: lines already decremented are restored in the same transaction (an oversold Order fulfils nothing), the shortfall is stored on the Order row (`oversell_shortfall` — the refund step reads state from the row, never back out of the audit log, ADR-0003), and `order.oversell_detected` commits with `order.paid`. The refund is automatic and runs on the same webhook delivery, but *outside* that transaction because it is an external gateway call — `gateway.refund_attempted` is written first in its own transaction (the payment-link crash-trace discipline), then `PaymentGateway.refundPayment` (new seam method; stub mints `rfnd_stub_<seq>` deterministically and enforces Razorpay's captured-only/refund-once rules, real one calls `payments.refund` — §5.5: works only against captured test payments, which an Oversell guarantees), then one transaction for the one-way `paid → refunded` transition (guard in the WHERE clause), the stored `OversellPayload`, `order.refunded`, and the merchant-signed refund receipt (`refund_receipts` table, migration 0007) whose payload embeds the original Receipt's hash — charge and reversal verify as a pair with nothing but the two documents and the merchant key. The buyer's answer at `get_order_status` is an **Oversell** — third member of the failure vocabulary, `{kind: 'oversell', code: 'OVERSOLD', reason, shortfalls, refund}`, deliberately shaped unlike a Refusal (no `recoverable`) and unlike a Decline (no `attempts`). A failed refund call parks as `order.anomaly_detected` (`refund_failed`) with the Order still `paid` and the shortfall still on the row — re-running `refundOversoldOrder` completes it; money moving back is never pretended. `refunded` joins `cancelled` in the paid transition's exclusion list, so a redelivered capture cannot flip a refunded Order back to paid. One command reproduces everything: `npm run failure:oversell`.
Also decided — the T8 revisit: a late capture on a **cancelled** Order still parks as `payment_after_cancellation` and does NOT auto-refund, even now that the refund path exists. Three reasons: (1) a cancelled Order never minted a Receipt, so the refund receipt's defining contract — referencing the original Receipt by hash — cannot be satisfied; a refund with no attestable charge behind it is a different document this build does not need. (2) The Oversell refund is safe to automate because its trigger is our own fulfilment check inside a transition we fully own; a capture landing on a cancelled Order means our view of the money and the gateway's have already diverged, and automatically moving more money on a path whose premise is "something is wrong" contradicts fail-closed discipline. (3) Anomalies are by definition the "recorded for a human" lane, and this one is exactly what it exists for. The operator refunds manually from the dashboard, with the anomaly event as the pointer.
Rejected: decrementing at capture-time webhook arrival regardless of transition winner (double-decrement under Razorpay's simultaneous sibling events); partial fulfilment of a multi-line oversold Order (half-shipped Orders with partial refunds — a much worse buyer story than full refund); refunding inside the detection transaction (network call inside a DB transaction); a `kind` reuse of `decline` or a `recoverable` field on the Oversell payload (would collapse the three-way failure vocabulary the viewer and buyers key on); auto-refunding `payment_after_cancellation` (above); a second row in `receipts` for the refund (its unique `order_id` index means one Receipt per Order — the refund receipt is its own table with its own shape).
Revisit when: a real partial-shipment feature ever exists (per-line fulfilment would need reservation or allocation, not this model); or the operator burden of manual late-capture refunds becomes real rather than theoretical.
Tier: Likely (Claude ruling during T9, 2026-08-26 — flagged for veto)

## 2026-08-26: T15 landed — the rule-auditor recomputes event-level, not cryptographic; `payment.verified` logs the idempotency key
Why: PLAN §6 says the auditor reads only the audit log, so "complete verified mandate chain" had to be *defined* in terms of what the log can prove. The definition chosen: every `order.paid` must trace, in seq order, through a `payment.verified` event whose `intentHash`/`cartHash` resolve to logged `mandate.intent_declared` / `mandate.cart_created` events of the same Agent; the Cart's total must re-add from its logged line items; the charged amount must be consistent across cart, verification, charge and Receipt; the charge must sit within the Intent's logged Budget; and the Agent must have a logged registration whose Cap the running captured-minus-refunded total never exceeds. That is event-level *recomputation* — the auditor re-derives totals, links and running sums from payloads, it does not re-verify Ed25519 signatures, because the log deliberately records mandate *hashes* and never detached signatures (the signed artifacts live in the mandate tables; the wire-level signature checks are the trust gate's job pre-charge, and the eval scenarios verify Receipts cryptographically at the protocol surface). Assert 3 ("no duplicate charge per idempotency key") forced one core change: `payment.verified` now carries the buyer-minted `idempotencyKey`, because the key previously lived only in app state (`payment_mandates`) and an auditor that consults app state is not reading the log alone. The auditor is strict — a payload missing a field it needs is a violation, never a shrug — and pure (rows in, report out), so the same function audits the eval batch's JSONL export, a tampered test log, or rows exported from a deployed database. Its Cap ledger counts money that *moved* (captures minus refunds), deliberately weaker than the app's pending-inclusive enforcement: the app proves the stricter rule at the gate, the auditor proves the outcome from the record. Scenarios run one-world-per-scenario (fresh PGlite + stub + HTTP server each) and the batch log is the union, tagged with scenario provenance the asserts never read — random ids make the flat union collision-free, and order-independence is what keeps 30 scenarios deterministic.
Rejected: auditor queries against live tables (reads app state — the exact "grading own homework" the design preempts); logging full signed payloads + signatures so the auditor could re-verify Ed25519 from the log (bloats every event, duplicates the mandate tables, and still proves less than the scenarios' wire-level Receipt verification already does); one shared world for all 30 scenarios (fast, but price-edit and stock-drain scenarios would couple scenario order to meaning); counting pending Orders toward the auditor's Cap total (a pending Order is not a charge; treating it as one would make the auditor assert something the log does not record).
Revisit when: the auditor is pointed at the deployed database's history — pre-T15 `payment.verified` rows lack `idempotencyKey` and pre-T4 paid Orders have no chain at all, so auditing that history needs either an epoch cutoff or a documented allowance for grandfathered rows.
Tier: Likely (Claude ruling during T15, 2026-08-26 — flagged for veto)

## 2026-08-28: The payer-bot drives MOBILE checkout and pays by UPI intent tile, not by typing a VPA
Why: the first real live run (2026-08-27) failed at `select UPI method`, and the tuning evidence the bot was designed to produce never left the terminal — so the first change is structural: `PaymentApprover` now takes a `{ record }` channel, every payer-bot step lands in the run transcript, and a failed required step dumps the page (screenshot + HTML + visible-element inventory per frame) into `evals/live-runs/artifacts/` with the paths carried on `PayerBotError.artifacts` into the run JSON. `npm run evals:probe` mints a real test-mode link from a canned decision — no model quota — and dumps every step, so tuning Razorpay's unversioned page costs a browser run instead of a Claude run. With that in place the actual walls were measurable (all three in docs/engineering-log.md): checkout rejects fake-looking mobile numbers on submit while accepting them visually, `fill()` leaves the field invalid where `pressSequentially()` does not, and — the load-bearing one — **desktop checkout's UPI screen is a QR code and nothing else**, so no desktop browser can ever complete a UPI payment unattended. The bot therefore runs in a mobile browser context (viewport/UA spelled out in `payerBot.ts` rather than taken from Playwright's `devices` registry, so a Playwright upgrade cannot silently change which page it drives), clicks `#mob-payment-btn`, types the contact number as keystrokes, continues via `[data-testid="bottom-cta-button"]`, and selects the `[data-value="upi"]` intent tile — which test mode settles server-side within seconds. Verified end to end against the deployment on 2026-08-28: Order `paid`, webhooks delivered, merchant-signed Receipt verified locally by the buyer. The VPA step survives as an OPTIONAL step for the day the UPI-ID field is on screen; the success signal remains the runner's `get_order_status` polling, never anything the bot sees.
Rejected: keeping desktop and tuning selectors harder (the control does not exist on that page — no selector finds it); paying by test card instead (scriptable, but drops the UPI/Reserve-Pay framing the whole pitch rests on); asserting success from the page's own confirmation screen (the page is Razorpay's and may close, redirect, or show nothing — our webhook-driven state is the only trustworthy signal); committing the page dumps (Razorpay's markup, large and binary — `evals/probe/` and `evals/live-runs/artifacts/` are git-ignored, and the step log, which is the part worth keeping, is in the run JSON).
Known gap: `failure@razorpay` needs the UPI-ID field behind "Apps & UPI ID" → "Others", which the bot does not yet reach, so the T8 decline rehearsal's LIVE take stays manual (the scripted `npm run failure:decline` is unaffected).
Revisit when: Razorpay reshuffles the hosted page (run `npm run evals:probe` first — the dumps say what changed), or the decline rehearsal needs to run unattended.
Tier: Likely (Claude ruling during T16 live runs, 2026-08-28 — flagged for veto)

## 2026-09-03: S1.1 — `MERCHANT_TOKEN` wins over *minting*, not over an existing token; the merchant gate writes no audit event
Why: the plan says "env token wins; otherwise mint once via a race-safe `UPDATE … WHERE token IS NULL`" and also "never rotates" — read literally, an env value set after a token was already minted would have to rotate it, contradicting the second rule. The stronger rule wins: `ensureMerchantToken` uses `MERCHANT_TOKEN` as the *candidate value* the race-safe update writes, so on a fresh database the deployment's token is adopted and a redeploy keeps whatever a connector was already configured with — but a row that already holds a token is never updated, whatever the environment says. That makes the function idempotent under every ordering (mint-then-env, env-then-mint, two concurrent seeds) and keeps the guard in the SQL `WHERE`, exactly as `ensureMerchantSigningKey` does. Rotation is an explicit tool, not a side effect of an env var (already parked in the plan's §10 follow-ups). Two smaller shapes decided here: `ensureMerchantToken` returns `{token, minted}` rather than a bare token, because `minted` is the only honest way for the seed to satisfy "log the token exactly once" — the row alone cannot say whether *this* run wrote it; and `requireMerchant` writes **no** audit event, unlike its buyer-face sibling `requireRegisteredAgent`, because the audit log is the money ledger the rule-auditor reads (ADR-0003) and the merchant face never moves money — the `confirmation.ts` precedent, where the whole catalog-lifecycle seam audits nothing.
Rejected: rotating on an env mismatch (breaks "never rotates" and would silently invalidate a configured connector mid-release); erroring on an env mismatch (turns a harmless stale variable into a failed boot of an otherwise healthy deployment); returning a bare token and having the seed diff it against a pre-read (a read-then-write race, the exact shape the SQL guard exists to avoid); writing `merchant.refused` on a bad token (would put non-money events into the ledger the auditor recomputes, and an almost-valid token is a secret-shaped string better kept out of a log served over HTTP).
Revisit when: merchant token rotation ships (plan §10), or a deployment ever hosts more than one Merchant — at which point "the deployment's token" stops being a singular thing.
Tier: Likely (Claude ruling during S1.1, 2026-09-03 — flagged for veto)
## 2026-09-03: Golden extraction request is a readable JSON fixture with a 1×1 placeholder image (for veto)
Why: `fixtures/extraction/openai-responses-request.golden.json` has to be reviewable by a human — the whole point is that a reader can see the request bytes drift — so it stores the parsed body plus a sha256 of the exact serialized text, and the test compares `JSON.stringify(golden.body)` against what the adapter sent (key order included). The image case uses a 1×1 JPEG rather than a dataset photo, which keeps the fixture at ~20 KB instead of ~200 KB of base64; the adapter treats every image identically, so the placeholder proves the `input_image` part's shape and `detail: 'high'` just as well.
Rejected: storing the raw body string only (byte-exact but unreviewable — a 20 KB single-line JSON string); a real dataset photo (a large, opaque fixture that pins nothing extra); a sha256 alone (a failing test would say "differs" and nothing more).
Revisit when: an adapter starts branching on the image — resizing, re-encoding, or switching `detail` by size — at which point the placeholder stops standing in for a photo.
Tier: Plausible (worker decision under S2.1; plan §5 did not force a fixture shape)

## 2026-09-03: S1.2 — the chat overlay resolves the draft itself and names the still-unknown field, rather than handing a half-submission to `confirmProduct`
Why: D2 fixes that `confirm_product` is additive (update-or-insert, never delete) and that the overlay happens server-side before the existing `confirmProduct` runs, but not what the overlay does when the merged result is still incomplete — a Variant whose stock the caption never stated and the merchant did not mention. `overlayConfirmation` resolves each stored Variant to `edit ?? stored` and, if either price or stock is still null, throws `INVALID_CONFIRMATION` **naming that variantId and label** ("variant L has no stock yet — send stock for variantId var_…"). The alternative — passing the null through and letting `normalizeSubmission` reject it — produces the same code with a message about a value of `null`, which is useless to an LLM that has to decide what to ask the merchant next; on a face whose whole job is a conversation, the error message *is* the interface. For the same reason a `variantId` that belongs to another Product (or to nothing) rejects `INVALID_CONFIRMATION` from the overlay instead of being silently skipped: on an additive face, ignoring an unrecognised edit would report success while dropping the merchant's answer. Two smaller shapes: `get_held_product` reads a Product in **any** status (it is `findConfirmationProduct`, and a merchant asking about a Product they just published should see it, not a `PRODUCT_NOT_FOUND` lie); and `errorResult`'s wire shape is `{error: {code, message}}`, deliberately a third shape beside `{refusal}` and `{validationError}` so S1.3's "the extraction model is not configured" can never be read as either a policy no or a complaint about the caller's arguments. Status and concurrency guards were **not** duplicated into the overlay: `PRODUCT_NOT_CONFIRMABLE` stays `confirmProduct`'s, where it lives in the UPDATE's WHERE clause and two concurrent confirmations cannot both win.
Rejected: mirroring the web screen's complete-state semantics on the chat face (D2 forbids it — an omission in a transcript is indistinguishable from a deletion the merchant wanted); unifying the two confirm paths behind one shape (the difference between "a click I did not make" and "a thing I did not mention" is real, and collapsing it would either make chat destructive or make the web screen unable to delete a phantom Variant); letting a partial answer publish with a defaulted stock of 0 (inventing the exact number checkout trusts — the thing the whole hold mechanism exists to prevent); an `errorResult` shaped like a `ValidationError` (would make `EXTRACTION_NOT_CONFIGURED` look like the merchant's fault).
Revisit when: S1.3 adds `submit_catalog_item` and the first `errorResult` caller lands — if it needs `retryAfterSeconds` (plan D5), the helper grows a third parameter then, not now.
Tier: Likely (Claude ruling during S1.2, 2026-09-03 — flagged for veto)

## 2026-09-03: S2.2 — the retry/timeout policy is the Chat Completions path's; the Responses adapter keeps its own bare `fetch` (for veto)
Why: plan D5's three-attempt policy lives in `extraction/providerHttp.ts`, and the ticket's file list puts it behind `chatCompletionsModel.ts` only. Routing the OpenAI Responses adapter through it too would have been coherent — one HTTP policy for both providers — but the OpenAI key is out of credits, so the golden request fixture and the recorded envelopes are the *only* evidence that path still works (plan §1). Every byte of that proof was captured against an adapter that calls `fetch` directly, and rewriting its transport in the same PR that adds a second provider would spend the regression guarantee to buy consistency on a path that cannot be exercised. The Responses adapter therefore gained exactly one thing this ticket: an optional `baseUrl`, so `EXTRACTION_BASE_URL` is not a variable that silently does nothing when the provider is `openai`. `EXTRACTION_TIMEOUT_MS` and the retries are consequently openrouter-only for now, which is stated in the README row rather than left to be discovered. Three smaller shapes decided here: config validation throws `ExtractionError` (the failure vocabulary ingestion already speaks) rather than a new error type; `readExtractionProviderConfig(env)` takes the environment as a parameter so config tests state a provider by building a record instead of mutating `process.env` (which leaks across a parallel vitest file); and a `Retry-After` above 20 s is *reported*, not slept through, because extraction runs inside a chat tool call whose whole wall-clock budget is a few minutes (plan §1) — the number still travels on the error as `retryAfterSeconds`, which is what lets S1.3's tool result say "retry in N seconds".
Rejected: putting `postJson` under the Responses adapter too (spends the golden/recorded-envelope regression proof to gain consistency on an unexercisable path — reconsider in S2.3, when live OpenRouter runs have shown the policy behaves); retrying on a timeout as well as on 429/5xx (three 60 s attempts is three minutes, past the claude.ai tool-call ceiling); a `provider` field on `ExtractionModel` (the seam callers see must not learn what is behind it — plan §5); defaulting `EXTRACTION_MODEL` for openrouter (a guessed namespaced model id spends money on the wrong model, silently).
Revisit when: S2.3's live runs land — at that point the OpenAI path can adopt `postJson` with real evidence behind the change; or a provider appears whose rate limits need a longer honoured `Retry-After` than 20 s.
Tier: Plausible (worker decision under S2.2; plan §5 named the modules but not the split of the HTTP policy between them)
## 2026-09-03: S1.5 — `store_summary` counts revenue from `paid` Orders only, at the database's UTC midnight, and publishes the Receipt's hash rather than a "receipt id"
Why: the plan fixes *what* the three read tools report but not the four edges each of those phrases hides. (1) **Revenue = `paid` only.** A `refunded` Order is money that arrived and then left again (T9's Oversell path); counting it as revenue would overstate the day, and netting it out would make "revenue" a different number from "what the gateway captured". It stays visible in `ordersByStatus`, which is where a merchant asking "what happened" should meet it. `cancelled` and `awaiting_payment` never represented money at all. (2) **"Today" is `date_trunc('day', now())` on the database clock — UTC**, not IST, because the deployment's clock is the only one the aggregate can see and a merchant-local day boundary would need a stored timezone the Merchant row does not have; for a demo whose recording window is a single afternoon the two agree, and the tool's own note says "today". (3) **`receiptHash`, not `receiptId`.** The ticket says "receipt id", but the `receipts` row id is an internal handle no endpoint has ever published; the Receipt's *identity* in this codebase is `hashMandate(payload)` — the same value a refund receipt links back to (`RefundReceiptPayload.receiptHash`). Publishing the row id would coin a second identifier for one document. It is derived from the payload `findOrderReceipt` already returns, so no new query was added. (4) **Low-stock and sold-out are disjoint lists**: a Variant at 0 appears in `soldOut` alone, because "restock this soon" and "this is unbuyable right now" are different instructions to the merchant, and a Variant in both lists would read as two problems. The one new SQL the plan allowed is `readStoreCounts` in `src/domain/storeSummary.ts` — a single `UNION ALL` over products-by-status, orders-by-status and today's paid sum — placed in the domain layer rather than in `merchantServer.ts` because every other query this face runs lives there, and an MCP handler that reaches for a table would be the first.
Rejected: netting refunds out of revenue (makes the number un-reconcilable against the gateway); a `revenue.refundedPaise` third field (a fourth read tool's worth of reporting, and D17 says three); an IST-fixed day boundary (hardcodes one merchant's timezone into a domain aggregate); publishing the `receipts` row id as `receiptId` (a second identifier for a document that already has one); folding sold-out Variants into `lowStock` (collapses two different merchant actions); three separate count queries (the summary is one chat turn and must not scale with the ledger); computing the counts in JavaScript from `listPublishedVariants` + a full order read (would pull the whole ledger over the wire to count it).
Revisit when: a Merchant row gains a timezone (then "today" becomes merchant-local), or refunds become common enough that a merchant asks where the money went.
Tier: Plausible (worker decision under S1.5; plan §4 did not force these shapes — flagged for veto)

## 2026-09-03: A catalog submission is never idempotent — each `submit_catalog_item` call creates a new Product (S1.3)
Why: the dataset path is deterministic *because* `ingest:demo` is re-run and must not clobber a merchant's confirmations; a merchant in chat has the opposite intent — sending the same drop twice means two drops, and silently merging them would make a real second listing vanish with no error the merchant could see. Keeping the two policies as one parameter (`IngestIds`) rather than two ingestion paths means the confidence gate, the hold rules and the persistence stay a single implementation.
Rejected: idempotency keyed on the client's `sourceId` (needs a merchant-visible way to say "no, really, again", and the client picks that id — plan §10 keeps it as a follow-up); hashing the caption (two genuinely identical restocks are not an error).
Revisit when: a merchant duplicates a listing by accident during a real run.
Tier: Plan-forced (plan §4 S1.3) — the *reason* recorded here, not the choice.

## 2026-09-03: `fetchImage` guards the URL host and the post-redirect host, but does not resolve DNS (for veto)
Why: `submit_catalog_item` is the only place the server fetches a caller-chosen URL, so it is the whole SSRF surface. Literal loopback/private/link-local addresses and a redirect that lands on one are both refused. Resolving the hostname first and pinning the connection to the resolved address is the complete fix, and it costs a DNS round trip on every submission plus a custom agent/dispatcher — for a one-merchant, one-token deployment whose only sink is "the bytes go to the extraction model", that was judged out of proportion for v1.
Rejected: no guard at all (turns the demo into an open proxy for the cloud metadata endpoint); resolve-then-pin (correct, disproportionate for v1); an allow-list of image hosts (breaks Take B's own `/demo/images` and any real merchant CDN).
Revisit when: more than one merchant holds a token, or the fetched bytes ever reach anything but the extraction model.
Tier: Agent decision, owner not consulted — flagged for veto.

## 2026-09-03: A merchant-supplied `imageUrl` is not written to the extraction record's `imagePath` (S1.3)
Why: `imagePath` is a repo-relative file the T13 viewer opens; a remote URL there renders as a broken image rather than as nothing. Submissions therefore record `imagePath: null` until the record gains a field of its own (plan §10).
Rejected: storing the URL in `imagePath` anyway (breaks the viewer for exactly the products the demo creates).
Revisit when: plan §10's "imageUrl on the extraction record" follow-up is picked up.
Tier: Agent decision (mechanical consequence of the viewer's contract).

## 2026-09-03: Removal is a maintenance script, never a merchant tool (S1.3, plan D3)
Why: recorded here because the plan decided *that* it is a script; the reason is that every other merchant tool is recoverable by saying the opposite thing in chat, and removal is not. An LLM that misreads "that one's wrong" as "delete it" would empty a buyer-visible catalog with nothing to undo it. `status = 'draft'` rather than DELETE keeps the Product, its extraction record and any Order that references it intact and auditable.
Rejected: an `archive_product` MCP tool (an LLM-triggered destructive catalog operation); a hard DELETE (breaks audit references).
Revisit when: never for this release.
Tier: Plan-forced (plan D3).
