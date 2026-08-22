# agent-store

Merchant-side agentic commerce infrastructure: takes a long-tail merchant's messy catalog and makes them transactable by AI buyer agents, with every money action gated by a signed mandate chain. Single context.

## Language

### Parties & identity

**Agent**:
A registered buyer identity — exactly one keypair plus the agent token minted by `register_agent`, nothing more durable. Re-registering creates a *new* Agent with a fresh cap; there is no stable buyer identity behind it (see ADR-0001).
_Avoid_: buyer account, user, client

**Merchant**:
The seller — a first-class entity owning a catalog and a signing key. v1 deploys exactly one, but nothing assumes that.
_Avoid_: store, shop, seller

### Catalog

**Product**:
A display and search grouping of Variants. Never the thing a cart line points at.

**Variant**:
The sellable unit. Stock, price, cart lines, and oversell checks all reference a Variant. Every Product has at least one (an implicit default when no size/color exists), so checkout never branches on "has variants?".
_Avoid_: SKU, item, option

**Published**:
The product-level state in which an Agent can see and buy a Product. Lifecycle: `draft → needs-confirmation → published`. One below-threshold field holds the *whole Product* out of `published` — there are no half-visible products.

**Confirmation**:
The Merchant's act of approving or correcting extracted fields whose confidence fell below the auto-publish threshold. High-confidence fields publish without it.

### Purchase flow

**Intent mandate**:
Agent-signed declaration of want plus Budget. Root of the mandate chain. Consumed by its first paid Cart mandate — one Intent authorizes at most one purchase; a second purchase needs a new Intent (refusal: `INTENT_CONSUMED`).

**Cart mandate**:
An immutable, both-sides-signed snapshot of exact Variant-level items, total, and price hash, returned by `create_cart` in one shot. There is **no stored, mutable cart** — the Agent holds its draft in its own context and "edits" by calling `create_cart` again (see ADR-0002).
_Avoid_: cart (as a mutable entity), basket, draft cart

**Payment mandate**:
Agent-signed authorization to pay one specific Cart mandate (by hash), carrying the idempotency key.

**Mandate chain**:
Intent → Cart → Payment, bound by embedded hashes, strictly 1:1:1 for money that moves. The only path through which money moves. Unpaid Cart mandates may coexist freely — safety is payment-time verification, never cart invalidation.

**Idempotency key**:
Buyer-minted unique string carried in the Payment mandate, scoped Agent×Merchant. Same key + same cart hash replays the original result; same key + a *different* cart hash refuses with `IDEMPOTENCY_REUSE`.

**Receipt**:
Merchant-signed machine-readable proof that a specific mandate chain led to a specific charge: Order ID, the three mandate hashes, amount, gateway payment ID, timestamp.

**Refund receipt**:
Merchant-signed document referencing the original Receipt, produced when an Oversell refund completes.

**Oversell**:
A fulfillment-time stock shortfall discovered *after* capture (the deliberate consequence of having no stock reservations) → automatic refund + Refund receipt.
_Avoid_: out-of-stock (that's the pre-payment refusal case)

**Order**:
Our domain purchase record — the thing with states like paid, cancelled, refunded, the subject of the audit trail and the rule-auditor. The unqualified word "order" always means this.
_Avoid_: using "order" for Razorpay's object

**Gateway order**:
The Razorpay-side object created at checkout. Always qualified: `gatewayOrderId` in code, "gateway order" in prose — never plain "order".

### Spend control

**Budget**:
The per-Intent spending limit the Agent declared in its Intent mandate. Enforced: cart total above Budget refuses with `OVER_BUDGET`.
_Avoid_: limit, allowance

**Cap**:
The Reserve-Pay-style spend ceiling for one Agent×Merchant pair, declared by the Agent at registration and immutable for that registration's lifetime. Enforced cumulatively: `OVER_CAP`.
_Avoid_: limit, quota, budget

### Records & money

**Audit log**:
The append-only record of every action, written atomically with the state change it records (ADR-0003) — complete by construction, but not what state is rebuilt from. The only thing the rule-auditor reads.
_Avoid_: event store, activity log

**Money**:
Always integer paise, INR only (`49900`, never `499.00`). No floating point anywhere money is computed or compared.

### Failure vocabulary

**Refusal**:
The trust layer saying no, on policy, *before* money moves (over-cap, over-budget, replay, tampered cart, unregistered agent). Always carries a structured `{code, reason, recoverable}` payload. The rule-auditor's guarantees are about Refusals.
_Avoid_: rejection, denial, error (for policy no-s)

**Decline**:
The payment gateway saying no *after* the trust layer said yes. A Decline is never a Refusal.
_Avoid_: refusal (for gateway failures), payment error

A malformed request (bad input, schema violation) is a plain validation error — neither a Refusal nor a Decline.
