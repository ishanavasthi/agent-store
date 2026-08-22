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

## 2026-08-22: Repo posture — reads as an infrastructure project; release logistics git-ignored
Why: the repository should stand as a real project on its own terms. All submission/release-specific material (form questions, deadline notes, video outline, research archive) lives in git-ignored `private/`.
Rejected: submission framing in PLAN.md/README (original rev 1 plan).
Revisit when: never.
Tier: Verified (user decision, 2026-08-22)
