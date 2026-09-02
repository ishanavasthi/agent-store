# Pre-release plan (2026-09-03): Merchant face over MCP + provider-agnostic extraction

> **For agentic workers:** each ticket below is a tracer-bullet vertical slice with its own tests. Work one ticket per fresh context, test-first (`/tdd`), `npm run typecheck && npm test` green in your worktree, PR against `main`, and the `ci` check must be green before anything merges. Steps use `- [ ]` for tracking. Vocabulary is `CONTEXT.md`'s; decisions that are hard to reverse go to `docs/adr/`; what breaks goes to `docs/engineering-log.md` as it happens.

**Status:** grilled and agreed 2026-09-03 (owner: Ishan). Ship: build Sep 3, record + submit Sep 4, Sep 5 slack. Applications close Sep 5.

**Spec + tickets:** spec #36; tickets #37–#44 (table at the end). Step 0 PR: #35.

## 1. Why

agent-store turns a long-tail merchant's messy IG captions + photos into Variants that AI buyer agents can buy over MCP. Today products enter the catalog only through `npm run ingest:demo`, a developer-run script over a hand-built dataset. Two things change before submission:

1. **A merchant adds products from claude.ai chat.** The connector is the *front door* only: the caption (verbatim) and optionally an image URL cross the chat→server gap, and **extraction always runs server-side** through the existing pipeline (`ingestItem` → confidence gate → `published` or held in `needs-confirmation`). If name, description, price and stock clear the 0.90 gate the Product is buyable in the same call; a field the caption did not state (almost always stock) costs one chat turn (`confirm_product`), not a visit to the URL. That gate is the demo beat, not friction to hide. Merchant identity is a `merchantToken` presented in-protocol on a **separate MCP face** (`/merchant/mcp`), mirroring `agentToken` on the buyer face; transport stays authless (PLAN §3/§5.2). The merchant also reads their store from chat — a small, fixed set of tools, no parity with the web UI.
2. **Extraction is provider/model agnostic.** OpenAI (Responses API, `gpt-5-mini`, must not regress) and **OpenRouter** (OpenAI-compatible Chat Completions; `z-ai/glm-5.3-flash` and `minimax/minimax-m3:free` compared, best one ships). OpenRouter accepts `response_format` but **does not enforce json_schema**, so zod validation of every payload becomes the hard guarantee and a per-provider output mode `json_schema | tool_call` (a forced tool call whose arguments are the schema) is the best approximation of strict mode. The OpenAI key is out of credits: the OpenAI path is proven by golden-request + recorded-envelope tests, no live calls. **The demo depends on the OpenRouter adapter landing** (S2.1–S2.2), even though WS1 is built first.

Facts that shaped this (verified 2026-09-02/03): the ingestion path uses multimodal input + Structured Outputs and **no tool calling**; `ExtractionModel` (`src/ingestion/types.ts`) is already the DI seam; the payload is `JSON.parse` + a bare cast today; all domain functions are `merchantId`-parameterised; MCP SDK 1.30.0 has no image-typed tool argument, so a claude.ai connector cannot forward attachment bytes; `zod ^4.4` has `z.toJSONSchema`; the GitHub repo is private (demo images must be served by the deployment); CI ran no tests before this plan; claude.ai tool calls of 10–60 s work (community ceiling ~4–5 min); OpenRouter `:free` = 20 req/min, 1000/day with ≥$10 credits (the account qualifies); paid GLM has no published per-key limit.

## 2. Decisions (grilling 2026-09-03)

| # | Decision |
|---|---|
| D1 | Bad merchant token → `Refusal({ code: 'UNKNOWN_MERCHANT_TOKEN', recoverable: true })`; glossary notes the merchant face borrows the Refusal shape. No audit event (the audit log is the money ledger — `src/domain/confirmation.ts` precedent, ADR-0003). |
| D2 | `confirm_product` over MCP is **additive**: update-or-insert, never delete. `title?`, `description?`, `variants[]` with `variantId` (update `pricePaise?`/`stock?`) or `label` without id (insert). Overlays the stored draft server-side, then calls `confirmProduct`. The web confirm screen keeps complete-state semantics. |
| D3 | Mis-submitted products are removed by a maintenance script (`catalog:archive` → `status = 'draft'`), not a tool. |
| D4 | Abuse surface accepted for v1 (one merchant, token in transcripts; rotation = set `MERCHANT_TOKEN` + redeploy, stated in ADR-0005). `fetchImage` refuses loopback/private/link-local addresses, non-`image/*`, > 4 MiB. |
| D5 | Extraction HTTP: 3 attempts on 429/5xx with backoff honouring small `Retry-After`; on final failure the tool result says "retry in N seconds". |
| D6 | Plan lives here; `PLAN.md` §8 M7 carries the revision pointer. |
| D7 | One ticket per slice, one PR per ticket, green `ci` required to merge. |
| D8 | Railway only for this release; Render stays on the previous build and README says so. |
| D9 | De-scope ladder (§6). |
| D10 | OpenRouter account holds ≥ $10: full 28-item runs for GLM and MiniMax in both output modes. |
| D11 | Video leads with the merchant take; the buyer buys **that** product; audit replays it. Optional 10-s closer: "any sales?" via `store_summary`. |
| D12 | Submit Sep 4. |
| D13 | Demo records on Pro/Max claude.ai accounts (two connectors) — the free-tier one-connector limit is not a plan constraint. |
| D14 | Video take = Take A (drop screenshot → verbatim transcription → caption-only extraction); Take B (caption + `/demo/images/…` URL) rehearsed as backup. A 29th caption is drafted in the dataset's voice, stating a price and **no stock** so the hold fires on camera; owner vetoes wording. |
| D15 | Two parallel chains in Orca worktrees, one terminal per ticket (§7). |
| D16 | Release gate (§8). |
| D17 | Merchant read tools are exactly three (S1.5); a fourth proposal is a no. |
| D18 | S1.5 blocked by S1.2 only; dies second on the ladder. |
| D19 | Execution runbook lives here; tickets carry `stream:WS1` / `stream:WS2`. |
| D20 | CI gate (`.github/workflows/ci.yml`: typecheck, viewer typecheck, vitest on PR + push to main) lands in Step 0. |

ADR-0005 ("Merchant identity is a token presented in-protocol on a separate MCP face, and extraction never happens client-side") qualifies on all three criteria and is written in S1.4. ADR-0006 ("structured output is validated by us; provider enforcement is advisory") is **skipped** — not hard to reverse — and recorded in `DECISIONS.md` in S2.3.

## 3. Step 0 — done in this PR

- [x] `CLAUDE.md` release-logistics rule points at `../agent-store-pvt/` (the private companion repo); `PLAN.md` references updated; stale local `private/` removed.
- [x] `.github/workflows/ci.yml` — the merge gate.
- [x] `PLAN.md` §8 M7 revision; this document.
- [x] `../agent-store-pvt/submission-notes.md`: video outline reordered (D11), checklist date (D12), merchant-connector take notes.

## 4. Workstream 1 — Merchant face over MCP

One new seam: `submitCatalogItem()` in `src/ingestion/submission.ts`. Everything else reuses existing functions.

### S1.1 Merchant token — schema, migration, seed, gate
Blocked by: none.
Landed: PR #PRNUM, 2026-09-03
- [x] `src/db/schema.ts`: `merchants.token text` nullable + `uniqueIndex('merchants_token_idx')`; `npx drizzle-kit generate --name merchant_token` → `drizzle/0009_merchant_token.sql` + journal + snapshot.
- [x] `src/domain/merchants.ts`: `newMerchantToken()` (`mrc_tok_` + 32 random bytes base64url, as `newAgentToken`), `ensureMerchantToken(db, merchantId, preferred?)` (env wins; else race-safe `UPDATE … WHERE token IS NULL`, as `ensureMerchantSigningKey`), `requireMerchant(db, merchantId, merchantToken, tool)` → `MerchantRow` | `Refusal(UNKNOWN_MERCHANT_TOKEN)`.
- [x] `src/domain/refusal.ts`: `UNKNOWN_MERCHANT_TOKEN` in `RefusalCode` (TS only).
- [x] `src/db/seed.ts`: `ensureMerchantToken(db, MERCHANT_ID, process.env.MERCHANT_TOKEN)`; log once when minted. `.env.example`: `MERCHANT_TOKEN=`.
- [x] Tests (`src/domain/merchants.integration.test.ts`): mint once / never rotate; env token adopted idempotently; `requireMerchant` happy + refusal shape + audit chain still empty.

### S1.2 Merchant face skeleton — confirmation-in-chat tools + `/merchant/mcp`
Blocked by: S1.1.
- [ ] `src/mcp/toolResults.ts`: move `textResult`, `refusalResult`, `validationResult`, `withToolErrors` verbatim from `server.ts`; add `errorResult(code, message)`. `server.ts` imports them, no behaviour change.
- [ ] `src/mcp/merchantServer.ts`: `createMerchantMcpServer(deps)` — name `agent-store-merchant`, merchant `instructions`, tools `list_held_products`, `get_held_product`, `confirm_product` (D2 overlay over `findConfirmationProduct` + `confirmProduct`), `list_my_products` (`listPublishedVariants` grouped by product). Every handler starts with `requireMerchant`.
- [ ] `src/http/app.ts`: extract the stateless block into `mountStatelessMcp(app, path, createServer)`; mount `/mcp` and `/merchant/mcp` — the latter **before** `app.use('/merchant', …)`; add to the `/` endpoints listing.
- [ ] Tests: `src/mcp/merchantFace.integration.test.ts` (PGlite + `InMemoryTransport` + `call()` from `src/testSupport/mcpTestClient.ts`, as `agentRegistration.integration.test.ts`): refusal on every tool + no audit write; list held (holds, null stock); get held / `PRODUCT_NOT_FOUND` as validationError; confirm (overlay of stock only) → buyer face `get_product` lists it; omitted variant row is **not** deleted; `INVALID_CONFIRMATION` + `PRODUCT_NOT_CONFIRMABLE` mapping; `list_my_products` shows published only. `src/http/mcpFaces.integration.test.ts`: real HTTP via `StreamableHTTPClientTransport` — tool-set isolation between faces; `GET /merchant/mcp` → 405.

### S1.3 `submit_catalog_item` — caption(+image) → existing pipeline
Blocked by: S1.2.
- [ ] `src/ingestion/ingest.ts`: `IngestIds { productId(sourceId); variantId(sourceId, label) }`, `DEMO_INGEST_IDS` = today's `productIdForSource`/`variantIdForSource`, `IngestOptions.ids?` defaulting to it → `runIngestDemo.ts` unchanged.
- [ ] `src/ingestion/fetchImage.ts`: `fetchImage(url, { fetchImpl?, maxBytes = 4 MiB, timeoutMs = 10 s })` → `ExtractionImage`; http(s) only; D4 address guard; `content-type: image/*`; size cap by header and while streaming; `AbortSignal.timeout`. Failures → `ValidationError('INVALID_IMAGE')`.
- [ ] `src/ingestion/submission.ts` (**the WS1 seam**): `CatalogSubmission { caption; imageUrl?; imageBase64?; imageMediaType?; sourceId? }`; `SUBMISSION_INGEST_IDS` via `newId('product')` / `newId('variant')`; `sourceId = 'sub_' + (slug(client sourceId) | uuid)`; `submitCatalogItem(db, merchantId, model, submission, { fetchImpl?, now? })` → `IngestedProduct`. Blank caption / both image forms → `ValidationError('INVALID_SUBMISSION')`. No idempotency in v1.
- [ ] `src/domain/refusal.ts`: `ValidationErrorCode` += `INVALID_IMAGE | INVALID_SUBMISSION`.
- [ ] `src/deps.ts`: `extractionModel?: ExtractionModel`, `fetchImpl?: typeof fetch`. `src/ingestion/extractionModel.ts`: `createExtractionModelIfConfigured()` → `null` when no key. `src/index.ts`: wire + log enabled/disabled; boot never requires an LLM key.
- [ ] `merchantServer.ts`: `submit_catalog_item({ merchantToken, caption, imageUrl?, imageBase64?, imageMediaType?, sourceId? })`; description: caption **verbatim** (or the verbatim visible text of a screenshot), never a description of the photo; a public photo link goes in `imageUrl`; each call creates a new Product. No model → `errorResult('EXTRACTION_NOT_CONFIGURED')`; `ExtractionError` → `errorResult('EXTRACTION_FAILED', …, retryAfterSeconds?)`. Result `{ productId, sourceId, status, title, holds, nextStep }`.
- [ ] `scripts`/`src/ingestion/archiveProduct.ts` + `catalog:archive` npm script (D3).
- [ ] Tests: `fetchImage.test.ts` (scheme, private address, content-type, oversize header/body, timeout, happy jpeg); `submission.integration.test.ts` (ids `/^prd_/` not `prd_demo_`, `sub_` sourceId, two calls → two Products, demo path still `prd_demo_`); `merchantFace.integration.test.ts` tracer: **submit (canned model, stock unstated) → `needs_confirmation` hold `stock` → `list_held_products` → `confirm_product` → buyer `get_product` shows the new variantId**; `EXTRACTION_NOT_CONFIGURED`; `INVALID_IMAGE` via injected fetch; archive script hides the product from `get_product`.

### S1.4 Demo images, docs, ADR-0005, submission notes
Blocked by: S1.3.
- [ ] `src/http/app.ts`: `app.use('/demo/images', express.static('fixtures/demo-dataset/images', { fallthrough: false, maxAge: '1h' }))`.
- [ ] `README.md`: "Merchant connector (add products from chat)" under "Connecting a Claude client"; env table `MERCHANT_TOKEN`, `EXTRACTION_*`; Refusal code list + `UNKNOWN_MERCHANT_TOKEN`; Render note (D8).
- [ ] `CONTEXT.md`: **Ingestion pipeline**, **Extraction model**, **Held**, **Merchant face** (Face: two → three), **Merchant token**, **Catalog submission**; Refusal entry notes the borrow.
- [ ] `docs/adr/0005-merchant-identity-in-protocol-on-a-separate-face.md` (house format: H1 sentence, body, `## Why`, `## Consequences`).
- [ ] The 29th demo caption + screenshot mock (D14) under `fixtures/demo-dataset/` (not in `dataset.json`; not scored).
- [ ] `../agent-store-pvt/submission-notes.md`: take script finalised with the deployed token/URLs.

### S1.5 Merchant reads — `store_summary`, `list_recent_orders`, `get_order`
Blocked by: S1.2.
- [ ] `store_summary({merchantToken})`: published/held counts; orders by status; revenue paise today/total; low-stock Variants (≤ 2); sold-out Variants; recent Refusals as unmet demand (count + last 5 reasons). Reuse `listPublishedVariants`, `listRecentOrders`, `listRecentRefusals`; one aggregate query for the counts.
- [ ] `list_recent_orders({merchantToken, limit?})`: id, status, amount paise, variant labels, receipt id, created at — via `listRecentOrders`.
- [ ] `get_order({merchantToken, orderId})`: `findOrderById` + `readPurchaseAuditChain` — the same data `/viewer/orders/:id` shows; unknown id → `PRODUCT_NOT_FOUND`-style validationError (`ORDER_NOT_FOUND`).
- [ ] Merchant `instructions` gain one sentence; README subsection lists the three.
- [ ] Tests in `merchantFace.integration.test.ts`: summary counts after seeding one paid + one cancelled order via the stub gateway (`src/testSupport`); low-stock and sold-out lists; refusals count; `get_order` chain matches `readPurchaseAuditChain`.

## 5. Workstream 2 — Provider-agnostic extraction

Only seam callers see: `ExtractionModel`. Internal seam: `ExtractionProviderConfig` + two adapters behind `createExtractionModel()`. Layout `src/ingestion/extraction/`: `payloadSchema.ts`, `toExtraction.ts`, `prompt.ts`, `config.ts`, `providerHttp.ts`, `openaiResponsesModel.ts`, `chatCompletionsModel.ts`. `openaiExtractionModel.ts` becomes a re-export shim.

### S2.1 Zod-validate the payload, pin the schema, make the OpenAI adapter testable
Blocked by: none (parallel with WS1).
- [ ] **Golden first**: capture the exact request body the current code sends (one item with image, one without) into `fixtures/extraction/openai-responses-request.golden.json` via an injected fetch, before touching the adapter.
- [ ] `payloadSchema.ts`: `modelPayloadSchema` (zod; `{value, confidence}` per field, `variantStock` as `{label, count}[]`), `responseJsonSchema()` = `z.toJSONSchema(...)` with override (nullable → `type:[T,'null']`, drop int min/max, drop `$schema`) — test asserts deep-equality with the current `RESPONSE_SCHEMA` literal.
- [ ] `toExtraction.ts`: move `toExtraction`/`field`/`toVariantStockRecord`/`nonEmpty` verbatim; `parsePayload(rawText)` = JSON.parse + `safeParse`, `ExtractionError` with zod path + 300-char snippet. Semantic rules (confidence clamp, null→0, `parseRupeePrice`, never invent stock) stay here.
- [ ] `openaiResponsesModel.ts`: today's code on the shared modules; `fetchImpl?`; `reasoning.effort` only for `gpt-5*`.
- [ ] Tests: schema pin; zod accepts all 28 `records[i].raw` in `fixtures/demo-dataset/runs/gpt-5-mini.json` and re-scoring via `scoreDemoItem` reproduces the committed summary; rejects map-shaped `variantStock`, string stock, missing key, extra key; request byte-equals golden; envelope walk with a leading reasoning item; refusal; `status: incomplete`; non-2xx carries the provider body. `demoRun.test.ts` untouched and green.

### S2.2 Provider config, Chat Completions adapter, retries
Blocked by: S2.1.
- [ ] `config.ts`: `ExtractionProviderConfig { provider: 'openai'|'openrouter'; apiKey; baseUrl; model; outputMode: 'json_schema'|'tool_call'; vision: boolean; timeoutMs; extraHeaders }` from `EXTRACTION_PROVIDER` (default openai), `EXTRACTION_API_KEY` (falls back to `OPENAI_API_KEY` / `OPENROUTER_API_KEY`), `EXTRACTION_BASE_URL`, `EXTRACTION_MODEL` (default `gpt-5-mini` for openai only; openrouter requires it), `EXTRACTION_OUTPUT_MODE` (default openai `json_schema`, openrouter `tool_call`), `EXTRACTION_VISION` (default true; false + image ⇒ `ExtractionError`, never silent), `EXTRACTION_TIMEOUT_MS` (60000), `OPENROUTER_SITE_URL` → `HTTP-Referer`, `OPENROUTER_APP_NAME` → `X-Title`. Only `OPENAI_API_KEY` set ⇒ byte-identical to today.
- [ ] `providerHttp.ts`: `postJson` with `AbortSignal.timeout`; D5 retries.
- [ ] `chatCompletionsModel.ts`: `messages:[system INSTRUCTIONS, user [{type:'text'},{type:'image_url',image_url:{url}}]]`, `max_tokens`, no `reasoning`; `json_schema` → `response_format:{type:'json_schema',json_schema:{name,strict:true,schema}}`, read `choices[0].message.content`; `tool_call` → `tools:[{type:'function',function:{name:'record_extraction',parameters,strict:true}}]` + forced `tool_choice`, read `tool_calls[0].function.arguments`; `message.refusal` / `finish_reason==='length'` → `ExtractionError`. Both adapters end in `parsePayload` → `toExtraction`.
- [ ] `extractionModel.ts`: switch on provider; `DEFAULT_EXTRACTION_MODEL` stays `'gpt-5-mini'`. `.env.example`, README env table.
- [ ] Tests: `config.test.ts`; `providerHttp.test.ts` (429→200, 500→200, 400 no retry, three 429s fail after 3 attempts with `retryAfterSeconds`, timeout aborts); `chatCompletionsModel.test.ts` (both request shapes, image part, no `reasoning`, extra headers, content vs tool-arguments parsing, refusal, drifted GLM-style payload → zod `ExtractionError`, vision:false throws before fetch).

### S2.3 Live runs, smoke + compare scripts, decision record
Blocked by: S2.2.
- [ ] `runAccuracy.ts`: openai keeps `runs/<model>.json`; other providers → `runs/<provider>-<slug(model)>.json`; record gains `provider`, `outputMode`.
- [ ] `runExtractionSmoke.ts` + `ingest:smoke` (`--items=N`, default 3, no DB); `runCompare.ts` + `ingest:compare` (table over `runs/*.json`).
- [ ] Live: full 28-item runs — `z-ai/glm-5.3-flash` × {json_schema, tool_call}, `minimax/minimax-m3:free` × {json_schema, tool_call}; commit records + comparison in `fixtures/demo-dataset/README.md`. Pick the demo model: `publishedWithWrongField === []` first, then per-field accuracy, then latency.
- [ ] `DECISIONS.md`: validated-by-us entry. Engineering-log entries for whatever broke.
- [ ] Hand the owner the Railway env block: `EXTRACTION_PROVIDER`, `EXTRACTION_API_KEY`, `EXTRACTION_MODEL`, `EXTRACTION_OUTPUT_MODE`, `MERCHANT_TOKEN`.

## 6. De-scope ladder (first to die → last)

1. `ingest:compare` script
2. S1.5 merchant reads
3. MiniMax runs (keep GLM only)
4. `list_my_products`
5. Take B (`imageUrl`, `/demo/images`)
6. S2.3 committed OpenRouter records (keep the smoke evidence)
7. Confirmation-in-chat (fall back to the web confirm screen, which already works)

**Never cut:** `submit_catalog_item` with server-side extraction; zod validation; the golden regression tests; the CI gate.

## 7. Execution runbook (D15, D19)

Two chains, disjoint files until S1.3 touches `src/ingestion/extractionModel.ts` (adds `createExtractionModelIfConfigured`; S2.2 rewrites that file → **WS2 rebases on `main` after S1.3 merges**). Other known seams: `README.md` env table (S1.4 + S2.2, trivial), `src/domain/refusal.ts` (WS1 only), `package.json` scripts (S1.3 `catalog:archive`, S2.3 `ingest:*`).

```
WS1:  S1.1 ─► S1.2 ─► S1.3 ─► S1.4
                 └──► S1.5
WS2:  S2.1 ─► S2.2 ─► S2.3
```

**Coordinator loop** (a fresh session, `orchestration` skill): spawn the frontier (initially S1.1 and S2.1), wait `worker_done`, verify (`gh pr checks` green, read the diff against the ticket's acceptance criteria), merge, spawn the tickets the merge unblocked. Never merge red; never merge without the ticket's tests present.

**Worker contract** (in every spawn prompt): read this document's section for the ticket and the ticket body; `/tdd` one behaviour at a time; per-worktree install is `npx --yes npm@10.9.3 ci` (the lockfile trap) and `.env` is copied from the main checkout (worktrees do not share untracked files; never commit it); `npm run typecheck && npm test` green; PR titled `<ticket-id>: <title>` referencing the issue; the documentation discipline below satisfied **in the same PR**; then `worker_done`.

**Documentation discipline — every ticket, same PR, verified by the coordinator before merge.** The repo's docs are the product's memory and they go stale the moment a PR merges without them:

| When the ticket… | …the PR also updates |
|---|---|
| lands anything | this document: tick the ticket's `- [ ]` boxes; add a one-line "Landed: PR #n, <date>" under the slice heading |
| makes a choice not forced by the plan (a default, a shape, a rejected alternative) | `DECISIONS.md` — dated entry, what/why/alternatives, flagged "for veto" if the owner did not choose it |
| hits a bug, a red build, a dependency contradicting its docs, or a trap | `docs/engineering-log.md` — Symptom → Cause → Fix → (Lesson), newest first under a `## 2026-09-0N — <ticket> <label>` heading, written when found, not at the end |
| introduces or sharpens a domain term | `CONTEXT.md` glossary (house entry format; add `_Avoid_` synonyms) — S1.4 owns the bulk, but a term coined earlier goes in with the ticket that coined it |
| changes what a user, operator or connector sees | `README.md` (env table, connector sections, Refusal codes, npm scripts) |
| makes a hard-to-reverse, surprising, traded-off decision | `docs/adr/000N-…md` (ADR-0005 is S1.4's; anything else must pass all three criteria) |
| leaves something only the owner can do or judge (a live run, a rehearsal, a wording veto, an env value) | `../agent-store-pvt/pre-release/MORNING_REVIEW.md` — append, ordered by importance |
| merges | coordinator appends the PR line to `../agent-store-pvt/pre-release/HANDOFF.md` (what landed, integration done between merges, test counts) |

The coordinator refuses to merge a PR whose diff touches code but none of the docs above when the table says it should; "docs later" is not a state.

**Trigger for the fresh session** — paste:

> `/spawn-agent` — implement the pre-release tickets in `docs/superpowers/plans/2026-09-03-pre-release.md` §7 as two Orca-worktree chains (WS1: #37→#39→#41→#43, #42 after #39; WS2: #38→#40→#44), one terminal per ticket, using the worker contract and documentation discipline in §7; coordinate with the `orchestration` skill: merge only green PRs whose docs are updated, rebase WS2 after S1.3, and keep `../agent-store-pvt/pre-release/{HANDOFF,MORNING_REVIEW}.md` current after every merge. Launch every worker under `CLAUDE_CONFIG_DIR=$HOME/.clawde` (the `~/.claude` login is expired — see "Which Claude account" below); the `yolo` alias is the unattended form.

**Unattended runs:** the owner may be AFK. Workers must not block on permission prompts — spawn them in a non-interactive permission mode appropriate to a throwaway worktree, and route anything that needs a human (an env value, a wording veto, a live take) to `MORNING_REVIEW.md` instead of waiting. The `railway` CLI is linked to project `agent-store` and the `use-railway` MCP server is installed, so the coordinator deploys (`railway variables --set …`, `railway up`, then `/healthz`); the env block still goes on `MORNING_REVIEW.md` for the record.

**Which Claude account (this machine).** The default Claude Code config (`~/.claude`) has an **expired** OAuth login. The working account lives in `~/.clawde`; every Claude Code invocation on this machine must carry `CLAUDE_CONFIG_DIR=$HOME/.clawde` — the shell aliases are `clawde` (= `CLAUDE_CONFIG_DIR=$HOME/.clawde claude`) and `yolo` (= `clawde --dangerously-skip-permissions --model claude-opus-4-8 --effort medium`, the right one for unattended worktree workers). Orca terminals may not load aliases, so use the env-var form explicitly. This applies to: (1) the worker terminals `spawn-agent` launches — a worker started as bare `claude` fails at login; (2) the local MCP smoke in S1.2/S1.3 — `CLAUDE_CONFIG_DIR=$HOME/.clawde claude mcp add --transport http agent-store-merchant http://localhost:3000/merchant/mcp`, then a `clawde` session; (3) any Agent-SDK run (`npm run evals:live`, which rides the CLI login) — export `CLAUDE_CONFIG_DIR=$HOME/.clawde` and keep `ANTHROPIC_API_KEY` unset; verify with `--dry-run` first since the SDK inherits the env from the spawning shell.

Fallback without Orca: `Agent` with `isolation: "worktree"`, same contract, coordinator in-session.

## 8. Release gate (D16) — all true before recording on Sep 4

- [ ] `npm run typecheck && npm test` green on `main`; `ci` green on the last merge.
- [ ] Railway deployed with migration 0009 applied; `MERCHANT_TOKEN` and `EXTRACTION_*` set; `/merchant/mcp` and `/mcp` list the right tool sets from a real client.
- [ ] Committed accuracy record for the chosen OpenRouter model shows `publishedWithWrongField = []`.
- [ ] One full rehearsal of the video flow on the deployed URL: merchant take (held → confirm) → buyer purchase of that product (`success@razorpay`) → `/viewer` replay → optional `store_summary`.
- [ ] `../agent-store-pvt/submission-notes.md` outline and checklist current.

## 9. Demo playbook (claude.ai)

1. Connectors → Add custom connector → `https://agent-store-production-8345.up.railway.app/merchant/mcp`, no auth. Token from Railway `MERCHANT_TOKEN`.
2. **Take A:** drop the IG screenshot; "New drop — add this to my store. Merchant token mrc_tok_…" → one `submit_catalog_item` with the verbatim visible caption → `needs_confirmation`, hold `stock` → Claude asks → "S 4, M 6, L 5" → `confirm_product` → `published` → "what's on sale?" → `list_my_products`.
3. **Take B (backup):** caption in a code block + "photo: https://…/demo/images/<file>.jpg" → `submit_catalog_item` with `imageUrl` → same flow.
4. Buyer connector (`/mcp`): "Buy <new product> in M, budget ₹2,000" → `get_product` → `register_agent` → `declare_intent` → `create_cart` → `submit_payment` → `success@razorpay` → `get_order_status` Receipt → `/viewer` replay.
5. Optional closer on the merchant connector: "any sales today?" → `store_summary`.

## 10. Follow-ups (not in this release)

- Submission idempotency keyed by client `sourceId`.
- `imageUrl` stored on the extraction record so the T13 viewer shows chat-submitted photos.
- Merchant token rotation tool; per-token daily submission cap.

## Tickets

| Ticket | Issue | Stream | Blocked by |
|---|---|---|---|
| S1.1 Merchant token | #37 | WS1 | — |
| S1.2 Merchant face skeleton | #39 | WS1 | #37 |
| S1.3 `submit_catalog_item` | #41 | WS1 | #39 |
| S1.4 Demo images, docs, ADR-0005 | #43 | WS1 | #41 |
| S1.5 Merchant reads | #42 | WS1 | #39 |
| S2.1 Zod payload + golden | #38 | WS2 | — |
| S2.2 Provider config + Chat Completions | #40 | WS2 | #38 |
| S2.3 Live runs + scripts | #44 | WS2 | #40 |
