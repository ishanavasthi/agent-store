# Engineering log

What broke while building this, and what fixed it. Newest entries first.

`DECISIONS.md` records what we chose and why; this file records what surprised us. When a fix turned on a decision, the entry links there rather than restating it.

Each entry is **Symptom → Cause → Fix → Lesson**. The Cause is the mechanism, not the guess that preceded it — an entry whose cause reads "probably X" is unfinished.

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
