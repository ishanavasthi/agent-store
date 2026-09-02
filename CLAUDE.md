# agent-store

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues (`ishanavasthi/agent-store`), via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default label vocabulary — the five canonical labels used as-is. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Engineering log

Record what broke in `docs/engineering-log.md` — after fixing a bug, getting a failed build or deploy green, hitting a dependency that contradicts its own docs or types, or finding a trap that will mislead again. See `docs/agents/engineering-log.md`.

### Release logistics

Submission notes, the video outline and the research archive live in their own repo, **`agent-store-pvt`** (GitHub `ishanavasthi/agent-store-pvt`, checked out beside this one at `../agent-store-pvt/`), so every worktree sees them and they are versioned. Update `../agent-store-pvt/submission-notes.md` — and commit there — whenever the deploy topology, a milestone date, or the demo flow changes; nothing in this repo's `git status` will remind you it went stale. If a `private/` folder still exists in some checkout it is the stale pre-move copy: ignore it, never write to it.
