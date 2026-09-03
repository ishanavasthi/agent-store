# Engineering log

What broke while building this, and what fixed it. Newest entries first.

`DECISIONS.md` records what we chose and why; this file records what surprised us. When a fix turned on a decision, the entry links there rather than restating it.

Each entry is **Symptom → Cause → Fix → Lesson**. The Cause is the mechanism, not the guess that preceded it — an entry whose cause reads "probably X" is unfinished.

---

## 2026-09-03 — the §8 release gate measures naming pedantry, not extraction safety

### `publishedWithWrongField` scores a Tee/T-Shirt synonym the same as an invented stock total

**Symptom.** No OpenRouter configuration could pass plan §8's
`publishedWithWrongField = []`, while the committed `gpt-5-mini.json` (OpenAI Responses path)
passed it. The obvious reading — "OpenAI is better, top up the credits" — was wrong, and acting
on it would have spent money to fix nothing.

**Cause.** Three consecutive 28-item runs of `openai/gpt-5-mini` × `json_schema` over OpenRouter
put **every** wrong field in one column: `name`, nine misses in total, with price, stock,
variantLabels, variantStock and description presence at **140/140**. Each name miss is a
near-miss synonym — `JALEBI Tie-Dye T-Shirt` for `JALEBI Tie-Dye Tee`, `THELA Tote Bag` for
`THELA Canvas Tote`, `Sling Bag` for `Crossbody Sling Bag` — produced at 0.85–0.95 confidence,
so whether a run passes the gate depends only on whether one such synonym happens to cross the
0.90 auto-publish threshold. The committed record's `[]` is that coin landing well: same model,
same weak field, but its one wrong name arrived at confidence 0.70 and was held. `scoreDemoItem`
compares names by exact string match, and `publishedWithWrongField` does not weight by field, so
a cosmetic naming variant and GLM's invented stock total of 13 (summed from a per-variant split
the caption never totals) are recorded as the same event.

**Fix.** None in code — the finding is the fix. The gate needs to distinguish fields that move
money or inventory (price, stock, variantStock, variantLabels) from a product name a merchant
would happily accept. Restricted that way, gpt-5-mini via OpenRouter is clean in 3 of 3 runs and
GLM still is not. Amending §8 is the owner's call and is the top item of
`../agent-store-pvt/pre-release/MORNING_REVIEW.md`; the three-run evidence is in
`fixtures/demo-dataset/README.md`.

**Lesson.** A release gate built on an unweighted equality check over a hand-labelled field will
eventually gate on the label's wording rather than the system's safety. When a gate fails, check
*which* field failed and whether the scorer's notion of "wrong" matches the harm you were
guarding against — before concluding the model is the problem. Also: one passing record is not
evidence of calibration; n=1 on a threshold test is a coin flip you have not flipped twice.

---

## 2026-09-03 — S2.3 live runs: MiniMax-M3 ignores both output modes, and `.env` is not a shell script

### MiniMax-M3 returns a shape neither `response_format` nor a forced tool call constrains

**Symptom** — `npm run ingest:smoke -- --items=3` against
`minimax/minimax-m3:free` failed on the *first* item in both output modes, and
reproducibly:

- `EXTRACTION_OUTPUT_MODE=json_schema` → ``Could not parse extraction payload
  as JSON: ```json `` — the model wrapped the object in a markdown fence, which
  is the one thing `response_format: {type: 'json_schema'}` is supposed to make
  impossible.
- `EXTRACTION_OUTPUT_MODE=tool_call` → ``did not match the schema at
  `variantLabels`: Invalid input: expected object, received array``. The
  payload was well-formed JSON and *flattened* the per-field envelope:
  `"variantLabels": ["S","M",…]` instead of `{"value": [...], "confidence": n}`,
  while `name`, `description`, `priceText` and `stock` kept the envelope.

**Cause** — OpenRouter accepts `response_format` and `strict: true` on a forced
tool call and forwards them, but does not *enforce* either; enforcement is the
upstream provider's, and MiniMax-M3 does neither. So both knobs are a request,
not a constraint, and a model that half-follows the schema produces a payload
that is syntactically fine and semantically wrong — the worst failure shape,
because nothing but validation distinguishes it from a good one. GLM-5.3-Flash
on the same account, same adapter, same request bytes honoured both.

**Fix** — none, by design. Coercing a flattened field back into the envelope
would be the adapter inventing a confidence the model never reported, in the
exact fields the confidence gate reads; MiniMax was dropped under the plan §6
de-scope ladder (rung 3, "MiniMax runs — keep GLM only") and the smoke output
above is its record. The four planned records became two, both GLM.

**Correction (2026-09-03, coordinator).** The cause above is right about the
mechanism but wrong about who to blame. OpenRouter's own model metadata
declares `structured_outputs: false` for **`minimax/minimax-m3:free`** and
`structured_outputs: true` for the paid **`minimax/minimax-m3`**. The free
variant is not a rate-limited version of the paid one — it lacks the capability
entirely, which is exactly why `response_format` and a forced `strict` tool call
both read as suggestions. Plan D10 chose `:free` on price grounds without
checking that field.

Re-smoking the **paid** `minimax/minimax-m3` × `json_schema` (3 items, ~$0.005;
$0.30/M in, $1.20/M out — cheaper than `gpt-5-mini`) confirms it: items 1 and 2
returned a correct, fully-enveloped payload with plausible per-field
confidences. So MiniMax-M3 *can* honour the schema; the `:free` tier cannot.

It still is not demo-viable, for a different and softer reason: item 3
(`03-aandhi-windcheater`) came back as a 200 with **empty content and
`finish_reason: 'stop'`** — `The provider returned no message content`. That is
not one of the transient faults `providerHttp` retries (429/5xx), and the
accuracy runner aborts the whole run on a failed item, so a 28-item run would
die on item 3 and commit nothing. Retrying an empty 200 would be a real change
to the retry policy, not a config tweak, and nothing in the release needs it.

**Lesson (added).** Read the provider catalogue's capability flags before
choosing a model on price. `:free` and paid variants of the same name can differ
in what they *can* be asked to do, and a plan that names a `:free` model has
made a capability decision without noticing.

**Lesson** — a per-field `{value, confidence}` envelope is not just a data
shape, it is the thing that made this failure *loud*: a bare
`variantLabels: string[]` schema would have parsed this payload cleanly and put
an unconfirmed size list into the catalog. Validate the envelope, and smoke a
new provider for 3 items before spending 28 — this cost 4 requests to learn.

### A 4000-token cap tuned on one provider killed a 28-item run on its 23rd live call

**Symptom** — the GLM `json_schema` full run failed at item 23 of 28 with
``The model stopped at the 4000-token limit before finishing the payload``
(`finish_reason: 'length'`), after 22 successful live calls. The same model in
`tool_call` mode completed all 28.

**Cause** — `MAX_TOKENS = 4000` in `extraction/chatCompletionsModel.ts`, added
in S2.2 as a round number. The extraction payload is ~400 tokens, so the cap
looked like 10x headroom; what actually consumes the budget is the model's own
preamble before the constrained object, which differs per model and per output
mode and is not something the request controls. `providerHttp`'s retries do not
help and should not — a truncated answer is a deterministic outcome of the
request, not a transient server fault.

**Fix** — the cap is now `12_000`, with the reasoning written next to it: it
exists to stop a runaway, not to size the answer, so it belongs well clear of
any payload this schema can produce rather than snug against the expected one.
The two `chatCompletionsModel.test.ts` assertions that named 4000 now name the
new value, so the constant is still pinned rather than free to drift. **This
did not rescue the run** — see the next entry; it converted a truncation into a
timeout on the same item, which is how the real cause got found.

**Lesson** — an output cap sized against the *expected* answer is a landmine
under a batch job: it fires late, after the run has spent real money, and only
on the inputs that provoke the longest preamble. Size it against the runaway
you are guarding, not the answer you are expecting — and put the number in the
test, so raising it is a decision rather than a diff nobody reads.

### GLM-5.3-Flash in `json_schema` mode does not terminate on one dataset item, three attempts running

**Symptom** — the GLM `json_schema` 28-item run failed at item 23 of 28,
`23-machli-mesh-shorts`, three times, having spent 22 live calls each time:

| attempt | `max_tokens` | `EXTRACTION_TIMEOUT_MS` | outcome at item 23 |
|---|---|---|---|
| 1 | 4 000 | 120 000 | `finish_reason: 'length'` |
| 2 | 12 000 | 120 000 | request aborted on timeout |
| 3 | 12 000 | 300 000 | request aborted on timeout |

Items 1–22 succeeded every time, in roughly 22 s each. The same model, same
adapter, same request bytes in `tool_call` mode completes all 28 in 239 s.

**Cause** — not the cap and not the clock: raising each in turn only moved
where the same non-termination surfaced. `23-machli-mesh-shorts` is the
dataset's "full per-variant split, no stated total" trap (`{S: 4, M: 7, L: 2}`),
and it is also the item GLM got *wrong* in `tool_call` mode by summing the split
to 13. Under `json_schema` constrained decoding the model appears to grind on
the same reconciliation without ever emitting a terminating object. Whatever the
internal mechanism, the observable is stable: this model, this mode, this item,
no completion inside five minutes.

**Fix** — none. GLM `json_schema` produced no committed run record, and this is
the entry that says why instead of a number that says nothing. `tool_call` is
the only OpenRouter configuration that completed a run.

**Lesson** — when raising a limit moves a failure instead of removing it, stop
raising limits: the second attempt is diagnosis, the third is stubbornness.
Two independent caps failing at the same input is the input talking, not the
caps. And a hard input is worth keeping in a dataset precisely because it
separates models this loudly — item 23 disqualified one mode and hung the other.

### GLM-5.3-Flash sums a per-variant stock split into product stock, confidently, and the gate publishes it

**Symptom** — the full 28-item `tool_call` run met the 70% floor on every
reportable field (name 93%, price 100%, stock 96%, variant labels 100%,
description 100%) and still reported `published items carrying a wrong field:
1`. The item was `23-machli-mesh-shorts`: `variantStock` extracted perfectly as
`{S: 4, M: 7, L: 2}`, and `stock` came back as **13** at confidence 0.90 where
the hand label says `null`.

**Cause** — 4 + 7 + 2 = 13. The caption states a per-variant split and no
total, and the dataset's labelling rule is explicit that per-variant counts are
never summed into product stock because a total the caption never states is an
inference, not a label. GLM did the arithmetic and reported the result as an
extracted fact, at a confidence high enough to clear `AUTO_PUBLISH_THRESHOLD`
(0.90) — so with every *other* field on that item correct and confident, the
Product auto-published carrying an invented number in the one column checkout
trusts. gpt-5-mini returns `null` here; this is a model behaviour difference,
not a pipeline bug.

**Fix** — none in code, and deliberately: the run record is evidence, and the
number that must be zero was 1. `tool_call` is disqualified as the demo mode by
the ticket's own first rule (`publishedWithWrongField === []` outranks
accuracy), and the choice moved to GLM's `json_schema` run.

**Lesson** — a per-field accuracy table can look excellent while the gate has
already failed, because accuracy averages over 28 items and the gate is a
worst-case property of each one. `publishedWithWrongField` is the number to
read first; the percentages are the tiebreak. Also: the traps that catch a
model are the arithmetic ones — a model that can add is a model that will
invent a total, and self-reported confidence does not distinguish a read value
from a computed one.

### `json_schema` mode is ~2.5x slower than `tool_call` and blows the 60 s default timeout

**Symptom** — the same GLM smoke that took 28 s for 3 items in `tool_call` mode
died in `json_schema` mode with `DOMException [TimeoutError]: The operation was
aborted due to timeout` on item 2; re-run with `EXTRACTION_TIMEOUT_MS=120000`
it completed 3 items in 67 s.

**Cause** — `EXTRACTION_TIMEOUT_MS` defaults to 60 000 (S2.2, tuned against
OpenAI Responses), and OpenRouter's `json_schema` path adds a constrained
decoding pass upstream: ~22 s/item versus ~9 s/item for the forced tool call,
with per-item variance that crosses 60 s on the longer captions. The retry
policy does not help — a timeout is an `AbortError`, not a 429 or a 5xx, so
`providerHttp` correctly does not retry it.

**Fix** — the live runs were made with `EXTRACTION_TIMEOUT_MS=120000`; the
figure is recorded in `fixtures/demo-dataset/README.md` next to the runs it
produced, and the Railway block in the PR keeps `tool_call` as the deployed
mode, where 60 s is comfortable.

**Lesson** — a timeout tuned on one provider is a property of that provider,
not of the operation. When a knob's default came from measuring one vendor, the
next vendor's first failure will be that knob.

### Sourcing `.env` from zsh is a parse error waiting for the first `&`

**Symptom** — `set -a; . ./.env; set +a` printed ``./.env:19: parse error near
`&` `` and then *appeared* to work, because the variable the next command
needed happened to survive.

**Cause** — `.env` is a key=value file, not a shell script. Line 19 is a
`DATABASE_URL` whose Neon query string contains an unquoted `&`, which zsh
reads as backgrounding. Everything after the failing line is loaded or not
depending on how the shell recovers — silently, and differently per shell.

**Fix** — the run commands export exactly the variable they need
(`export OPENROUTER_API_KEY="$(grep '^OPENROUTER_API_KEY=' .env | cut -d= -f2-)"`)
rather than sourcing the file.

**Lesson** — never `source .env` in a script whose result you will trust. A
partial environment fails later and somewhere else, which is the expensive kind.

## 2026-09-03 — S1.4 demo images: `express.static({ fallthrough: false })` turns a missing file into a 500

**Symptom.** With the plan's exact mount — `app.use('/demo/images', express.static('fixtures/demo-dataset/images', { fallthrough: false, maxAge: '1h' }))` — a request for a photo that exists is fine, but `GET /demo/images/no-such-drop.jpg` answers **500 `{"error":"internal_error"}`** and logs `unhandled request error` as though the server had crashed.

**Cause.** `fallthrough: false` does not send a 404 itself. It builds an `HttpError` with `status: 404` and hands it to `next(err)`, which is the whole point of the option: the miss becomes a *decided* answer instead of falling through to later routes (which is what would otherwise serve the viewer SPA's `index.html` for a missing JPEG). This app's final error handler answered every error identically — `res.status(500).json({ error: 'internal_error' })` — so a deliberate 404 arrived as an unexplained crash, complete with a scary log line on a path a judge might well try.

**Fix.** The error handler in `src/http/app.ts` now honours a 4xx `status`/`statusCode` carried on the error: it answers with that status and does not log. Everything without one is still `internal_error`, still logged. `src/http/demoImages.integration.test.ts` pins the 404 explicitly, and names in its comment what it is guarding against.

**Lesson.** A middleware option whose name says "do not fall through" says nothing about *how* it stops — Express's convention is that stopping means `next(err)`, so any option like it lands in the error handler. A catch-all error handler that ignores `err.status` silently converts every library's deliberate 4xx into a 500; the handler is the right place to learn the convention once, not each mount.

## 2026-09-03 — S2.2 provider config: the plan's merge-seam note pointed the wrong way

**Symptom.** The ticket said to look for `createExtractionModelIfConfigured()` in `src/ingestion/extractionModel.ts` and to rebase WS2 on `main` after S1.3 merged, per plan §7. The function was not there, and S1.3 had not merged.

**Cause.** §7 was written assuming WS1 would reach that file first (S1.3 adds the null-returning factory; S2.2 rewrites the module around a provider switch), so it recorded one rebase direction as if it were a fact about the file. WS2 ran ahead of WS1, and the assumption inverted: S2.2 reached the file first. A plan sentence that describes an *ordering* reads exactly like one that describes a *dependency*, and the next agent cannot tell which it was holding.

**Fix.** S2.2 owns the provider switch; `DEFAULT_EXTRACTION_MODEL`, `extractionModelId()` and `createExtractionModel()` were all kept exported and working, so S1.3's `createExtractionModelIfConfigured()` lands on top as an additive diff rather than a conflict. §7's sentence now carries a dated correction naming the real direction.

**Lesson.** In a plan with parallel chains, write the seam as an invariant both sides can satisfy ("whoever lands first keeps these exports"), not as a predicted merge order — the order is the one part of a parallel plan that is not under the plan's control.
## 2026-09-03 — S1.5 merchant reads

### `unionAll` is not exported from `drizzle-orm`, only from `drizzle-orm/pg-core`

**Symptom** — `import { and, eq, gte, sql, unionAll } from 'drizzle-orm'` — the
same root import every other query in `src/domain/` uses for its operators —
failed the typecheck with `TS2305: Module '"drizzle-orm"' has no exported
member 'unionAll'`, while `and`, `eq`, `gte` and `sql` on the identical line
resolved fine.

**Cause** — set operators are dialect-specific in drizzle: `union`, `unionAll`,
`intersect` and `except` are declared per dialect and exported from
`drizzle-orm/pg-core` (`query-builders/select.d.ts`), not from the root barrel,
which carries only the dialect-agnostic condition and SQL builders. The
distinction is invisible at the call site — both halves read like plain query
helpers — and drizzle's own doc comment shows the correct import only in an
example block.

**Fix** — a second import line in `src/domain/storeSummary.ts`:
`import { unionAll } from 'drizzle-orm/pg-core'`.

**Lesson** — when a drizzle symbol is missing from the root export, try the
dialect package before assuming a version mismatch. Anything that *builds a
statement* (set operators, table/column constructors) lives in `pg-core`;
anything that builds a *fragment inside* one lives at the root.

---

## 2026-09-03 — S1.3 submit_catalog_item

### Two Orca worktrees running `npm test` at once fail 87 tests that have nothing wrong with them

**Symptom** — a full `npm test` came back `16 failed | 27 passed (43)`,
`87 failed | 280 passed (367)`, with every failure identical:
`Error: Hook timed out in 10000ms` pointing at the `beforeEach` that calls
`createTestDatabase()`. Re-running the same commit alone: one real failure and
366 passes.

**Cause** — every integration test boots its own embedded PGlite, which is a
WASM Postgres that wants real CPU for a second or two. Two worktree workers
(S1.3 and S1.5) ran their suites concurrently on one laptop, so PGlite startup
crossed vitest's 10 s `hookTimeout` in whichever run lost the race. Nothing in
either diff was involved; the duration line is the tell — 430 s for the
contended run against 38 s for the clean one.

**Fix** — wait for the other worktree's suite to finish and re-run. Do not
raise `hookTimeout` to paper over it: the timeout is doing its job.

**Lesson** — in a parallel-worktree run, a wall of identical
`Hook timed out … createTestDatabase` failures is a machine-load report, not a
regression. Check `pgrep -f vitest` before believing it, and never report a red
suite from a contended run without re-running it alone.

### `BodyInit` is not a global type in this tsconfig, so `new Response(bytes)` typechecks but the obvious cast does not

**Symptom** — a test helper written as
`new Response(bytes as unknown as BodyInit, …)` failed `npm run typecheck` with
`TS2304: Cannot find name 'BodyInit'`, in a project where `Response` itself
resolves fine and the tests run.

**Cause** — the runtime globals come from `@types/node`'s undici typings, which
export the `Response` *class* globally but do not publish `BodyInit` as a global
type name (it is a DOM lib type). `lib` here does not include `DOM`, so the
class is in scope and the alias for its argument is not.

**Fix** — drop the cast. `new Response(uint8Array)` and `new Response(string)`
both typecheck on their own; the cast was defending against a problem that did
not exist.

**Lesson** — in a Node-lib project, reach for the *value* (`Response`) and let
inference do the rest; the DOM's helper type aliases are not there to be named.

### A `new Response()` reports `url` as the empty string, so a redirect guard has to tolerate that

**Symptom** — `fetchImage` re-checks `response.url` after the fetch so a
redirect into private address space is refused too. Under an injected
`fetchImpl` that returns a hand-built `Response`, that check ran against `''`
and threw `INVALID_IMAGE` on the happy path.

**Cause** — `url` is only populated on a `Response` that came from an actual
fetch; the constructor leaves it `''`. `new URL('')` throws, which the guard
correctly reports as "not a URL".

**Fix** — the post-redirect check runs only when `response.url` is a non-empty
string, and the test that needs it defines the property explicitly.

**Lesson** — a security check placed on a response field must state what it does
when the field is absent. "Absent" and "hostile" are different answers, and
picking the wrong one either breaks every test or opens the hole.

---

## 2026-09-03 — S2.1 zod payload + golden request

### zod reports an unrecognised key at an empty path, so the offending key names itself or nothing does

**Symptom** — `parsePayload` was supposed to name the zod path of whatever
drifted. For a payload carrying an extra key it said
``did not match the schema at `(root)` ``, which is true and useless: the one
thing a reviewer needs — *which* key — was only buried in the issue's prose.

**Cause** — a `unrecognized_keys` issue in zod 4 is raised *against the object
that owns the keys*, not against the keys themselves, so `issue.path` is `[]`
for a top-level payload. The offending names live on `issue.keys`, a property
that exists on that issue variant alone. `issue.path.join('.')` is the obvious
formatting and it silently discards them.

**Fix** — `issuePath` in `extraction/toExtraction.ts` special-cases
`code === 'unrecognized_keys'` and appends `issue.keys` to the parent path,
so the message reads ``at `colour` ``. The test asserts the key by name.

**Lesson** — when formatting a zod issue for a human, `path` is not the whole
address. `unrecognized_keys` (and `invalid_union`, which nests its own issues)
carry the specifics on variant-only properties, and a generic formatter drops
exactly the detail the error existed to carry.

### `node --experimental-strip-types` cannot run this repo's source; the golden capture had to go through vitest

**Symptom** — capturing the pre-refactor request body meant importing
`src/ingestion/openaiExtractionModel.ts` from a throwaway script. Run as
`node --experimental-strip-types capture.ts`, it died with
`ERR_MODULE_NOT_FOUND: .../src/ingestion/price.js`.

**Cause** — the repo is `NodeNext` ESM, so every internal import is written
`./price.js` and resolved to `price.ts` by the TypeScript compiler and by
vitest's resolver. Node's own type stripping does no such remapping: it loads
the specifier literally, and `price.js` does not exist until `npm run build`.
This is why `package.json` scripts run `npm run build && node dist/...` rather
than stripping types — `npm run dev` is the one exception and it only works
because it enters at a file whose transitive imports are all resolved the same
way it is, i.e. not at all until you hit one.

**Fix** — the capture ran as a temporary vitest test (deleted after it wrote
the fixture), which resolves the specifiers the same way the suite does.

**Lesson** — for a one-off script against this source tree, reach for a
throwaway `*.test.ts` and `npx vitest run` it, not `node
--experimental-strip-types`. Anything else needs a build first.

## 2026-08-28 — T16 payer-bot, first real runs

### The first live run died on a selector and left nothing to fix it with

**Symptom** — the 2026-08-27 live suite ended `1 error · 2 walked_away`. The one
buy attempt reached `gateway.payment_link_issued` and then failed with
`select UPI method: no candidate locator matched within 15000ms`. The payer-bot
was built to record which candidate matched at each step precisely for this
moment — but the step log went to `console.log` and nowhere else, so the run
JSON held one error string and the evidence was gone with the terminal.

**Cause** — `PaymentApprover` was `(payment) => Promise<void>`: the seam had no
channel back into the run's transcript, so `cli.ts` could only print. A step log
that exists only on an operator's screen is not evidence.

**Fix** — the approver now receives `{ record }` and every payer-bot line lands
in the transcript *and* the terminal; a failed required step dumps the page
(screenshot + HTML + an inventory of every visible interactive element in every
frame) into `evals/live-runs/artifacts/`, and `PayerBotError.artifacts` carries
the paths into the run JSON. `npm run evals:probe` mints a real test-mode link
from a canned decision — no model quota — and dumps the page at every step, so
selector tuning costs a browser run instead of a Claude run.

### Razorpay's hosted checkout: three traps, none of them documented

**Symptom** — with evidence in hand, the bot still could not pay. Three distinct
walls, each of which looks like the same "no candidate matched" error:

1. **The contact screen silently rejects fake numbers.** `9999999999` and
   `9876543210` both draw "Please enter a valid mobile number" *on submit* — the
   field looks accepted while typing. `7042318965` passes. Nothing states which
   numbers are filtered.
2. **`locator.fill()` does not satisfy the validator.** Filling the field leaves
   the digits visible but the form invalid; `pressSequentially()` (real
   keystrokes) is what makes checkout accept it.
3. **Desktop checkout cannot pay by UPI at all.** Its UPI screen is a QR code
   and a "Refresh QR" button — no UPI-ID field, nothing a bot can drive. The
   mobile layout lists the UPI intent apps (`[data-value="upi"]`), and in test
   mode selecting one settles the payment server-side within seconds.

**Cause** — checkout serves a different flow per viewport, and the automation was
driving the one where the payment control does not exist. The desktop QR is
also why the S1 spike's manual takes always used a phone-shaped window.

**Fix** — the payer-bot runs in a mobile browser context (spelled out in
`payerBot.ts`, not taken from Playwright's `devices` registry so an upgrade
cannot change what it drives), clicks "Proceed to Pay" (`#mob-payment-btn`,
mobile-only), types the contact number, continues via
`[data-testid="bottom-cta-button"]`, and selects `[data-value="upi"]`. Verified
end to end against the deployment on 2026-08-28: Order paid, webhooks fired,
merchant-signed Receipt verified locally by the buyer.

**Lesson** — "no candidate locator matched" is a symptom with at least three
unrelated causes, and a step log alone cannot tell them apart: it took a
screenshot to see the words "Please enter a valid mobile number". When
automating someone else's UI, capture the page, not just the trace. And the
remaining gap is honest: `failure@razorpay` needs the UPI-ID field behind
"Apps & UPI ID" → "Others", which this bot does not yet drive — the decline
rehearsal's live take stays manual.

---

## 2026-08-26 — T13 merchant confirmation screen

### The new `/merchant/confirmations` endpoint 500s against Neon while every test is green

**Symptom** — a local smoke run of the built server against the shared Neon database answered
`{"error":"internal_error"}` on `GET /merchant/confirmations`, with the log showing Postgres
`42703: column "extraction" does not exist` — while the full test suite (which runs the same
query) passed, and the same code worked against PGlite.

**Cause** — migrations reach Neon only through Railway's `preDeployCommand` (S1 spike
finding: the build sandbox cannot open the Neon WebSocket, so `db:migrate:prod` runs at
deploy). T12's migration `0008_ingestion_confidence.sql` — which adds `products.extraction` —
merged to main but had not been *deployed* yet, so the shared database was one migration
behind the code on every developer machine. Tests never see this because PGlite databases are
created from the committed migrations at full depth.

**Fix** — none needed in code: the next deploy of main applies 0008 before the new code
serves traffic, which is exactly the ordering `preDeployCommand` exists to guarantee. The
smoke run was re-pointed at PGlite-backed tests instead.

**Lesson** — "merged" and "migrated" are different states for the shared Neon database.
A branch that reads columns from the latest migration will 500 against Neon until main
deploys — check `drizzle/` depth against the deployed revision before concluding the new
query is wrong.

## 2026-08-26 — T12 ingestion pipeline

### `fetch` to api.openai.com died ENOTFOUND while `nslookup` resolved it fine

**Symptom** — every live extraction call failed with
`getaddrinfo ENOTFOUND api.openai.com`, from Node and from `curl` and `ping` alike — yet
`nslookup api.openai.com` returned real addresses, and other hosts (github.com) resolved
normally.

**Cause** — the machine was on a network whose primary DNS server (a CGNAT hotspot resolver,
first in `scutil --dns`) answers NXDOMAIN for this specific name — DNS-level filtering.
`getaddrinfo` (which `fetch`, `curl` and `ping` all use) trusts the system resolver chain and
stops at the first authoritative-looking no; `nslookup` speaks UDP straight to a nameserver
and got the real answer. `dscacheutil -q host -a name api.openai.com` returning *nothing* was
the confirming symptom: the system resolver path itself was the filter.

**Fix** — for the accuracy/ingest runs only: a scratch `--import` shim that overrides
`dns.lookup` to resolve through public resolvers (8.8.8.8 / 1.1.1.1) and falls back to the
original lookup. Deliberately **not** committed to the repo — it is a property of one
network, not of this project, and baking a resolver override into shipped code would be its
own trap.

**Lesson** — `nslookup` succeeding while `getaddrinfo` fails means the system resolver path
is lying, not the network. Diagnose with `scutil --dns` + `dscacheutil` before blaming the
API or the code.

### A prompt fix for truncated names produced doubled names instead

**Symptom** — on the first 28-item accuracy run the only field below 100% was name (23/28),
every miss a truncation: `Nazar Snapback` for "NAZAR Snapback Cap", `Thela` for "THELA
Canvas Tote". Adding a prompt rule "write the name followed by the full product type" fixed
those five — and created four new misses of the opposite shape: `Dhundh Beanie Beanie`,
`JALEBI Tie-Dye Tee T-Shirt`, `UDAAN Hoodie Sweatshirt`.

**Cause** — the rule was stated unconditionally, so the model applied it to names that
already end in the product type. An instruction tuned against the failing examples alone
described the fix for them, not the invariant ("name plus type, stated exactly once").

**Fix** — restate the rule with both directions and counter-examples ("expand `ZORA cargos`
→ `ZORA Cargo Pants`; but `ROSHNI Hoodie` never becomes `ROSHNI Hoodie Sweatshirt`"), rerun
the full 28 items: name 27/28, all other fields 100%. One care taken and worth keeping: the
first version of the fix quoted actual dataset answers ("GALLI Cargo Pants", "Crossbody
Sling Bag") as prompt examples — that is label text leaking into the extraction prompt, and
it was scrubbed for invented brand names before the run that counts.

**Lesson** — a prompt edit is a code change: rerun the whole eval after each one, expect the
fix to overshoot, and never let ground-truth label text into the prompt — an eval the prompt
quotes the answers to measures nothing.
## 2026-08-26 — T16 live-eval harness

### The hosted payment-link page cannot be scripted from documentation

**Symptom** — the Playwright payer-bot (PLAN §6) needs selectors for Razorpay's
hosted Payment Link page, and PLAN §7 lists those mechanics as a detail-level
unknown. Research did not close it: no Razorpay doc describes the hosted page's
DOM, and the docs are not even internally consistent about the flow — the
Payment Links API docs say UPI payment links are unsupported in test mode,
while the S1 spike (2026-08-24) completed two real test-mode purchases by
approving exactly such links with `success@razorpay` in the hosted checkout.
The resolution: "UPI Payment Link" is a distinct *link type* (`upi_link:
true`); an ordinary link's hosted page embeds standard checkout, whose
test-mode UPI flow accepts the magic VPAs (`success@razorpay` /
`failure@razorpay`, per razorpay.com/docs/payments/payments/test-upi-details).
What no source states: the page's DOM structure, whether checkout mounts in an
`iframe.razorpay-checkout-frame` or inline on the link page, or what the
post-submit screen shows in test mode.

**Cause** — the hosted page is Razorpay's, unversioned, A/B-tested, and only
rendered by real link URLs; there is no sandbox to rehearse against without
creating real test-mode links, which the harness build deliberately did not do
(real runs are human-triggered — Max quota + rails).

**Fix** — design for the uncertainty instead of guessing one selector set:
every payer-bot step walks a *list of candidate locators* across every
checkout-ish frame plus the main frame, records which candidate matched (or
that the step was skipped) into a step log that lands in the run evidence
JSON, and optional steps (contact screen, on-page confirmation) never fail the
run. The authoritative success signal is never the page: it is the runner's
`get_order_status` polling, i.e. the webhook flipping the Order to paid — the
same signal the S1 spike verified. `--dry-run` stops before any browser
exists, so CI can exercise everything up to the consent step.

**Lesson** — when a third party's UI is the only interface and its structure is
unknowable offline, make the automation report what it saw rather than assert
what should be there, and anchor success on your own system's state, not the
foreign page's pixels. The first human-triggered run turns the candidate lists
into facts; the step log is what makes that tuning a diff instead of a
debugging session.

---

## 2026-08-26 — T10 extraction spike

### Every `node --experimental-strip-types src/…` script dies on its first import

**Symptom** — running the new spike runner produced
`ERR_MODULE_NOT_FOUND: Cannot find module '…/src/domain/money.js' imported from …/src/ingestion/spike/runExtractionSpike.ts`.
The file it named does not exist and never will: the source is `money.ts`, and `dist/` is what
holds `money.js`. `npm run db:seed` fails identically on `src/config.js`, so this is not
specific to the new code — every npm script of the form
`node --experimental-strip-types src/<entry>.ts` has the same failure, `db:seed`, `db:migrate`
and `dev` included.

**Cause** — Node's type stripping removes types and nothing else. It does **not** perform
TypeScript's `.js` → `.ts` import-specifier remapping, so `import … from './money.js'` is
resolved literally against the filesystem. This codebase writes `.js` specifiers everywhere
because `verbatimModuleSyntax` + `NodeNext` require the *emitted* extension, which is correct
for `tsc` and unrunnable by the stripper. Verified on the dev machine's Node 26.7; there is no
flag that changes it — `node --help` offers only `--experimental-strip-types` /
`--no-strip-types`, nothing about specifier resolution.

Nothing caught this earlier because the deploy targets never run these scripts: Render and
Railway run the compiled `db:migrate:prod` / `db:seed:prod` out of `dist`.

**Fix** — `spike:extraction` compiles first and runs the built JavaScript:
`npm run build && node dist/ingestion/spike/runExtractionSpike.js`. Relative fixture paths are
unaffected because `dist/ingestion/spike/` sits at the same depth below the repo root as
`src/ingestion/spike/`. The other three scripts are still broken on Node 26 and are left that
way here rather than fixed in passing — this entry is so the next person recognises it in
seconds instead of debugging a missing file.

**Lesson** — type stripping is not a TypeScript runtime. It runs the file you wrote, with the
types deleted; anything `tsc` would have *rewritten* on the way out — specifiers, enums,
namespaces — is still there and still wrong. If the build already produces runnable output,
run that.

---

## 2026-08-24 — T1 walking skeleton: first deploy and first real purchase

### Every checkout against real Razorpay rails failed

**Symptom** — `checkout` over MCP returned `Failed to create Payment Link at Razorpay`. The same keys created a Payment Link fine via `curl`, so the credentials were not at fault.

**Cause** — the payload sent `customer: {}`. The live API rejects an empty object outright: `BAD_REQUEST_ERROR — incorrect JSON object received - faulty key: customer`. The field has to be **absent**, not empty. Isolated by replaying our exact payload against the API and removing one field at a time.

**Fix** — build the payload without `customer`. The Razorpay Node SDK's own types declare `customer` as required, which is wrong against the live API, so the payload is typed as `Omit<…, 'customer'>` and cast once at the call site with the reason written beside it. Pinned by a regression test asserting the key is absent.

**Lesson** — a vendor SDK's types are a claim about the API, not the API. When the type system pushes you toward a payload the service rejects, trust the wire.

### A gateway failure that could not be diagnosed from logs

**Symptom** — the failure above surfaced to the operator as nothing but `Failed to create Payment Link at Razorpay`. Nothing in the deployment logs said why.

**Cause** — the catch wrapped the error and discarded it. Razorpay nests the useful part at `error.error.description`.

**Fix** — log the gateway's own `code` and `description` before wrapping.

**Lesson** — an error message that omits the upstream's own words converts a two-minute fix into an investigation. Wrap for the caller; log for the operator.

### Three `gateway.order_linked` events for one linking

**Symptom** — the first real purchase produced an audit chain containing `gateway.order_linked` three times, though only one gateway order was ever linked. `order.paid` correctly appeared once.

**Cause** — a read-then-write race. Razorpay fires `payment_link.paid`, `payment.captured` and `order.paid` for one purchase at effectively the same moment. The linking step tested `order.gatewayOrderId === null` against a row read earlier in the transaction, then wrote unconditionally, so all three concurrent webhooks saw `null` and all three linked. `order.paid` was immune because its guard already lived in the `WHERE` clause.

**Fix** — move the guard into the statement: `UPDATE … WHERE id = ? AND gateway_order_id IS NULL … RETURNING`. Under READ COMMITTED the losers block on the row lock, re-evaluate `IS NULL` after the winner commits, and match nothing. Losers re-read the row before reporting a conflict rather than trusting their stale snapshot.

**Lesson** — a guard read in application code is not a guard. Concurrency correctness belongs in the `WHERE` clause. This codebase already had the correct pattern twenty lines below the defect, which is the more useful lesson: check whether the invariant you need is already solved nearby.

### A gateway order that no payment would ever hit

**Symptom** — found in review before deploying. The audit chain recorded one gateway order id at checkout, and the Order row later held a different one.

**Cause** — a Razorpay Payment Link mints its **own** internal gateway order. We were also creating one explicitly, recording its id, and then the webhook silently overwrote the column with the id the payment actually ran through. The chain and the row disagreed about which gateway object the money touched.

**Fix** — the Payment Link is the sole checkout-time gateway artifact. `gatewayOrderId` is learned from the webhook, written exactly once as its own audit event, and a conflicting second value is recorded as an anomaly instead of overwriting. The `order_id` echoed by the link-create response is kept only as a non-authoritative hint.

**Lesson** — when a provider creates objects on your behalf, find out which one the money actually moves through before recording anything as authoritative.

### Orders marked paid without checking what was paid

**Symptom** — found in review. Any `payment_succeeded` webhook flipped the Order to `paid`, and the `order.paid` audit payload carried the *order's* amount rather than the amount actually paid.

**Fix** — compare the webhook's amount to the Order's before acknowledging money. A mismatch or a missing amount records a structured anomaly and leaves the Order untouched. The payload now carries the webhook's amount.

**Lesson** — "the gateway said success" and "the gateway collected what we asked for" are different claims. Fail closed on the second.

### A malformed webhook could be redelivered forever

**Symptom** — found in review. A signed webhook carrying an unparseable amount raised a money-domain error, escaped as a 500, and Razorpay redelivers on any non-2xx — indefinitely.

**Fix** — parse failures raise a webhook-parse error, and the route answers `200` with an `ignored` result and a log line.

**Lesson** — with an at-least-once delivery system, a 5xx on a permanently bad payload is an infinite loop. Distinguish "retry me" from "this will never parse".

### Reflected XSS in the audit view

**Symptom** — found in review. `orderId` was interpolated unescaped into the audit HTML; the `href` was encoded but the visible text was not.

**Fix** — escape on output, plus `encodeURIComponent` inside the href. Verified against a script probe.

### Refusals that did not match the documented contract

**Symptom** — found in review. Refusals shipped as `{code, message}`, and one error type spanned both a real Refusal (`OUT_OF_STOCK`) and a plain validation error (`INVALID_QUANTITY`).

**Cause** — `CONTEXT.md` reserves **Refusal** for a trust-layer policy denial before money moves, carrying `{code, reason, recoverable, retryAfter?}`; a malformed request is neither a Refusal nor a Decline.

**Fix** — a `Refusal` type with the documented shape and a code union, and a deliberately different validation-error type with no `recoverable`. Surfaced through MCP as distinct fields.

**Lesson** — one type spanning two vocabulary categories means an agent client cannot tell retryable from terminal. See `CONTEXT.md`.

### Nondeterministic webhook-to-Order matching

**Symptom** — found in review. Matching used a single `OR` across several columns with `LIMIT 1` and no ordering, so an event matching two Orders resolved arbitrarily.

**Fix** — strategies tried in strict priority order, each ordered and fetching two rows so a multi-match is *detected*; ambiguity records an anomaly and refuses to pay.

### `npm ci` rejected the committed lockfile on every deploy target

**Symptom** — the first two deploys died in about ten seconds: `npm error Missing: @esbuild/sunos-x64@0.28.2 from lock file`, plus the Windows platform packages. The lockfile did contain all 26 platform entries, so the message was misleading.

**Cause** — an npm major mismatch. The dev machine runs Node 26 / npm 11, which records nested optional platform packages in a shape npm 10 rejects when it builds its install tree. Every deploy target runs Node 22, which ships npm 10.

**Fix** — regenerate the lockfile under npm 10.9.3 and pin both halves in `package.json` (`engines.npm`, `packageManager`) so a later install on a newer Node cannot silently reintroduce it.

**Lesson** — the lockfile is only reproducible against the npm that wrote it. Pin the package manager whenever the dev runtime differs from the deploy runtime.

### `npm ci` in the Railway build command died with EBUSY

**Symptom** — `EBUSY: resource busy or locked, rmdir '/app/node_modules/.cache'`, exit code 240.

**Cause** — Nixpacks already runs `npm ci` in its own install phase and mounts `node_modules/.cache` as a build cache. Our build command ran `npm ci` a second time, which tries to clear `node_modules` and cannot remove the mount.

**Fix** — the Railway build command builds only. Render still runs its own `npm ci`, because there the build command *is* the whole build.

**Lesson** — a builder that installs for you turns an explicit install into a conflict. Deployment config does not port between platforms unchanged.

### Migrations cannot run in Railway's build step

**Symptom** — `migrate` failed on `CREATE SCHEMA IF NOT EXISTS "drizzle"` with `AggregateError [ETIMEDOUT]` opening `wss://…-pooler…neon.tech/v2`, while the deployed app was querying the same database happily.

**Cause** — Railway's build sandbox cannot open the Neon WebSocket; its runtime network can.

**Fix** — migrate and seed moved to `preDeployCommand`, which runs before any container takes traffic, preserving the invariant the build step protected: never serve new code against an old schema, and fail the deploy rather than crash-loop. Render keeps migrations in its build step, where the network reaches Neon.

**Lesson** — build networks and runtime networks are different networks. Anything touching a database belongs in a release phase, not a build phase.

### Testing stale code after a detached deploy

**Symptom** — a fix was deployed, the deployment list showed `SUCCESS`, and the endpoint still exhibited the old behaviour. A cycle was spent re-diagnosing a bug that was already fixed.

**Cause** — `railway up --detach` returns as soon as the upload completes. The `SUCCESS` being read belonged to the *previous* deployment.

**Fix** — deploy without `--detach`, or poll the specific deployment id until it reports `SUCCESS`, before testing.

**Lesson** — after any deploy, confirm the running build is the one you think it is before trusting what the endpoint tells you.

### Green tests, broken type check

**Symptom** — a newly added test passed under `vitest run` while `npm run typecheck` failed on it. The breakage was committed and deployed before it was noticed.

**Cause** — the test cast a plain number into a branded `Paise` slot. Vitest transpiles without type checking; `tsconfig.json` includes tests but `tsconfig.build.json` excludes them, so the build stayed green too.

**Fix** — brand the fixture through the domain helper. Run `typecheck` — not just `test` — before committing.

**Lesson** — a passing test suite is not evidence the types hold, and the build can hide it if tests are excluded from the build config.

### A transient Neon timeout failed a deploy

**Symptom** — a deploy failed on the same Neon `ETIMEDOUT` as above, then succeeded on retry with no change.

**Cause** — Neon's free tier scales to zero; a cold endpoint can time out the first connection.

**Lesson** — a serverless database in a deploy's critical path makes cold starts a deploy failure mode. Warming the endpoint first, or retrying, is expected rather than exceptional.

---

## Standing traps in the environment

Not bugs of ours — properties of the platforms that will mislead someone eventually.

**Razorpay test mode**
- Cancelling a payment still produces a **successful** payment, so "user cancels" can never be a failure scenario. The decline rehearsal uses `failure@razorpay` instead.
- `success@razorpay` is a sandbox-only VPA. It must be **typed** into the checkout page; scanning the test QR with a real UPI app gives "invalid QR", because a real app has nothing to resolve. Test-mode cards deduct nothing — the keys are `rzp_test_*`, and the gateway refuses to construct on any other prefix.
- Refunds work only against **captured** test payments.
- There is no API-only payment completion on an unactivated account; the hosted page is the only path. This is why the human approving the link is the consent step rather than a workaround.
- One purchase produces **three** webhooks (`payment_link.paid`, `payment.captured`, `order.paid`), all near-simultaneous, and any non-2xx is redelivered. Every webhook handler has to be both idempotent and concurrency-safe.

**Hosting**
- Render's free web service spins down after roughly 15 minutes idle; the keep-warm ping mitigates but does not eliminate the cold start.
- Railway has no free tier: a $5 one-time trial credit valid 30 days, then $5/month or services pause.

**Toolchain**
- The dev machine's default npm is 11.x while the repo pins npm 10 (`engines.npm` + `packageManager`), and the pin only **warns** (EBADENGINE) — it does not block. A bare `npm install` here silently regenerates `package-lock.json` in the npm-11 shape that npm 10 rejects on every deploy target (the 2026-08-24 incident above). It bit again on 2026-08-26 during T2's merge verification: the rewrite dropped ~470 lines of nested `node_modules/vitest/node_modules/@esbuild/*` entries and was caught by `git status` and reverted before commit. Safe invocation on this machine: `npx --yes npm@10.9.3 install …`. A `preinstall` engine guard (e.g. `npx check-node-version` or a one-line version test) would make the pin enforceable; not yet added.

---

## Standing tradeoffs

### Two backends, one database

Railway is primary and always-on; Render free is the K1 fallback. Both run the same commit against the same Neon database. See `DECISIONS.md` (2026-08-24).

**Safe by construction:**
- Only Railway's URL is registered with Razorpay, so only one backend receives payment events.
- Even under double delivery, the paid transition is a single conditional `UPDATE … WHERE status <> 'paid' … RETURNING`. Postgres serializes it, so `order.paid` is written exactly once — a database guarantee, not application logic.
- The seed is `onConflictDoNothing`; the audit log is append-only with transactional writes.
- Sharing the database helps rather than hurts: an Order created through one backend resolves correctly when its webhook lands on the other.

**The two real risks are about deploys, not runtime:**
1. **Simultaneous migrations.** Both platforms run the migrator against one database with no coordinating lock. Concurrent runs produce a *failed deploy*, not a corrupted schema, because Postgres DDL is transactional — but it is avoidable.
2. **Code/schema drift.** Railway deploys manually; Render auto-deploys on push. A destructive migration would break whichever backend is running older code.

**Current practice:** deploy sequentially, Railway first, then sync Render. The stronger guardrail — turning off Render's auto-deploy — is not yet applied.

### Deployment config diverges on purpose

Render runs `npm ci` and migrations in its build command; Railway builds only and migrates in `preDeploy`. Both entries above explain why. Keep the divergence and the reasons beside each other in `render.yaml` and `railway.json`, so neither is "tidied" into matching the other.
