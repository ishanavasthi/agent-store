# An Agent is nothing more than its registration

An Agent = one registered keypair + agent token, minted by `register_agent`. There is no stable buyer identity behind it: the same human reconnecting tomorrow and re-registering gets a *new* Agent with a fresh cap and a fresh idempotency space. We accept — and document in the README threat model — that Sybil re-registration can bypass the per-Agent cap in v1.

## Why

There is nothing to anchor a durable identity to: the MCP transport is deliberately authless (see DECISIONS.md 2026-08-22) and v1 has no OAuth or verified-agent registry. Pretending otherwise would be security theater. The honest framing is stronger: a verified agent registry is precisely what NPCI's UAP is expected to provide, and this gap is part of what the project illustrates.

## Consequences

- The rule-auditor's "no charge above cap" claim is scoped **per Agent registration**, and its report must say so.
- Cap and idempotency-key scoping key off the Agent row, never off any transport-level notion of "the same client".
- README threat model states Sybil re-registration as an explicit v1 non-goal.
