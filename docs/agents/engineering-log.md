# Engineering log

`docs/engineering-log.md` records what broke during the build and what fixed it. Append to it as part of the work that produced the finding — not in a later pass, which never happens.

## When to append

Write an entry the moment any of these resolves:

- **A bug is diagnosed and fixed** in our code.
- **A build, deploy, or CI run fails** and you get it green.
- **A dependency contradicts its own documentation or types** — an SDK type that disagrees with the live API, an endpoint rejecting a documented payload, a builder that fights the config.
- **You discover a trap** that will mislead the next person even though nothing broke this time (a provider's test mode behaving unlike production, an at-least-once delivery, a tier that sleeps).
- **You accept a tradeoff that leaves a known risk open** — record the risk and the practice that contains it.

One finding, one entry. A single fix that resolved three distinct mechanisms is three entries.

## What belongs elsewhere

The log answers "what surprised us". Route the neighbours to their own homes and link rather than restate:

- Why we chose something → `DECISIONS.md`
- A decision that is hard to reverse and surprising → `docs/adr/`
- What a term means → `CONTEXT.md`

## What makes an entry finished

The format is at the top of `docs/engineering-log.md`; follow the entries already there. An entry is finished when all three hold:

- **The Cause is the mechanism**, established by evidence — the log line, the isolating experiment, the two code paths that differed. An entry whose cause reads "probably" or "something to do with" is still open; go find out.
- **The Symptom is what was observed**, in enough detail that someone hitting it recognises it before they know the cause.
- **Someone who hits this again can act on the entry alone**, without reconstructing the investigation.

Add a **Lesson** when the finding generalises past this codebase. Skip it when the fix is merely local — a lesson that restates the fix is noise.

Prefer the specific over the tidy: real error strings, real identifiers, the actual command. Those are what a search will match on later.

## Placement

Newest first. Add today's entries under a dated session heading at the top of the entry list; create the heading if the date has none. Long-lived material — environment traps, standing tradeoffs — lives in the sections at the foot of the file, edited in place rather than appended to.
