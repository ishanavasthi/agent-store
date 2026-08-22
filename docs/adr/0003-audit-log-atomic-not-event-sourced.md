# Audit events commit atomically with state, but the system is not event-sourced

Every state transition writes its audit event in the **same database transaction** as the state change. The audit log is therefore append-only and complete by construction — it cannot silently miss an action — but operational state is *not* rebuilt from it. The log is a record, not the write model.

## Why

The rule-auditor's entire claim ("zero cap/mandate violations, judged from the audit log alone") rests on the log's completeness — fire-and-forget logging would make the audit theater. Full event sourcing would earn the same guarantee but costs projection machinery, replay tooling, and schema ceremony this build cannot afford before Sep 3, and proves nothing extra to the audience.

## Considered options

- **Fire-and-forget logging** — rejected: a log that can drop events proves nothing.
- **Full event sourcing** — rejected: heavy for a days-long build; the atomic-commit guarantee is the part the auditor actually needs.

## Consequences

- Any code path that mutates Order/payment/cap state outside a transaction that also writes the audit event is a bug by definition — review for this explicitly.
- The architecture doc states this guarantee, since a future reader of an "auditable" system will otherwise expect event sourcing and wonder why it's absent.
