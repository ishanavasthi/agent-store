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

## Known rough edge

The payer-bot's selectors against Razorpay's hosted page are candidate lists,
not verified facts — the page is unversioned and cannot be rehearsed offline.
The first real run may need a selector tuned; the bot's step log in the run
JSON says exactly how far it got (see docs/engineering-log.md, T16 entry).
If the bot fails, approving the printed link by hand (UPI → `success@razorpay`)
still completes the run — the runner's order-status polling is the success
signal, not the bot.
