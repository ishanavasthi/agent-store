# Live eval suite (T16) — how to trigger the real runs

The live suite is 3–5 REAL Claude-as-buyer runs (PLAN §6): the Agent SDK on
your Claude Code Max credentials decides what to buy from the DEPLOYED
catalog, T6's client-custody buyer executes the mandate chain over Streamable
HTTP, and a Playwright payer-bot approves the Razorpay-hosted Payment Link
with `success@razorpay`. **The runs are human-triggered by design** — they
spend Max quota, drive real test rails, and are non-deterministic; CI only
ever exercises the harness (vitest, against the local app + gateway stub).

## One-time setup

```sh
npx playwright install chromium   # the payer-bot's browser
```

Auth: none to configure — the Agent SDK resolves the same credentials Claude
Code uses. `ANTHROPIC_API_KEY` must NOT be set (it would silently bill API
credits instead of the Max subscription).

## Rehearsal (no money-moving step, no payment page)

```sh
npm run evals:live -- --target https://<deployment> --dry-run
```

This still runs Claude and still opens real mandate chains against the
deployment (Orders are left pending), but stops before the payment page.

## The real runs

```sh
npm run evals:live -- --target https://<deployment>
```

Flags: `--task <id>` (repeatable) runs a subset of
`black-tee-under-1500` / `out-of-stock-attempt` / `budget-capped-attempt`;
`--headed` shows the payer-bot's browser; `--out <dir>` moves the report
(default `evals/`). Without `--target`, `LIVE_EVAL_TARGET` then
`PUBLIC_BASE_URL` are consulted.

## What comes out

- `evals/live-report.md` — the human-readable report, headed by the
  non-determinism banner; kept SEPARATE from the scripted suite's
  deterministic scoreboard (PLAN §6) and never merged into it.
- `evals/live-runs/<timestamp>.json` — raw per-run evidence (decisions,
  transcripts, order ids), never clobbered by a rerun.
- Commit both after a real run: they are the acceptance evidence for #17,
  alongside the payments visible in the Razorpay test dashboard.

## Tuning the payer-bot without spending model quota

```sh
npm run evals:probe -- --target https://<deployment>            # inspect only
npm run evals:probe -- --target https://<deployment> --pay      # drive it for real
```

The probe buys the cheapest in-stock variant from a **canned** decision — no
model is asked — then opens the hosted page and dumps it at every step:
screenshot, HTML, and an inventory of every visible interactive element in
every frame, into `evals/probe/` (git-ignored). Inspect mode never touches a
payment control; both modes leave a real Order on the target, as `--dry-run`
does. `--variant <id>` picks a specific variant, `--headless` hides the browser.

This is the tool to reach for whenever the bot stops paying: Razorpay's page is
unversioned and changes without notice, and one probe run turns a selector
guess into a diff.

## What the bot actually drives (measured 2026-08-28)

A **mobile** browser context, deliberately: desktop checkout offers UPI only as
an unscannable QR, while the mobile layout lists the UPI intent apps, which
test mode settles server-side within seconds. The steps are "Proceed to Pay"
(`#mob-payment-btn`) → contact number, typed as keystrokes → Continue
(`[data-testid="bottom-cta-button"]`) → `[data-value="upi"]`. Two traps behind
that, both in docs/engineering-log.md: checkout rejects fake-looking mobile
numbers (`9999999999`, `9876543210`) with a message it only shows on submit,
and `fill()` leaves the field invalid where typing does not.

**Known gap:** `failure@razorpay` needs the UPI-ID field behind "Apps & UPI ID"
→ "Others", which the bot does not yet reach — the decline rehearsal's live
take stays manual. Every step's outcome, including which candidate locator
matched, is recorded into the run transcript; a failed required step dumps the
page into `evals/live-runs/artifacts/` and names the files in the run JSON. If
the bot fails anyway, approving the printed link by hand still completes the
run — the runner's order-status polling is the success signal, not the bot.
