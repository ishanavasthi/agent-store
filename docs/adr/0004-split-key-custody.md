# Key custody is split, and the column is the model: `private_key IS NULL` means the client signs

An Agent's Ed25519 key lives in one of two places, chosen at registration and immutable for the registration's lifetime (ADR-0001). **Custodial** (the default): `register_agent` mints the keypair server-side, stores both halves on the Agent row, and the server signs every agent-side mandate on the Agent's behalf. **Client custody**: the buyer registers with its own `publicKey` (base64 SPKI DER, the wire encoding fixed in `src/domain/keys.ts`), the row stores that key with `private_key` NULL, and the server never sees the private key — every agent-side signature arrives from the client and is verified against the stored public key before anything is stored or any money can move. There is no custody flag: `private_key IS NULL` is the whole model.

Both custody modes buy from the same protocol surface — the same five tools, the same mandate payloads, the same trust gate. The split shows up only as optional tool arguments (`createdAt`/`signature` on `declare_intent`; `cartSignature`/`paymentCreatedAt`/`paymentSignature` on `submit_payment`), and arguments that contradict the Agent's custody are refused as `CUSTODY_MISMATCH` validation errors in both directions.

## Why

A claude.ai connector client cannot hold a private key or compute signatures — every tool executes server-side — so custodial keys are what makes the connector demo possible at all. But custodial-only would mean the server signs both sides of its own mandate chain, which weakens the signature story to theater. The Agent SDK buyer (`src/buyer/`) holds its key client-side and signs locally, proving the chain's verification is real: the server *verifies* signatures it could not have produced (DECISIONS 2026-08-22 "Split key custody").

For a client-custody Agent the server recomposes each payload from the request's fields (`agentId`/`merchantId` from the token's own row, `createdAt` client-minted) and verifies the supplied signature over that recomposition — so what is verified, hashed, and stored is byte-for-byte what the client signed, with no separate payload-consistency checks to get wrong: sign different identity fields and the signature simply fails.

## The Cart signature is deferred to payment time

The Cart mandate is necessarily composed server-side — the server pins current catalog prices, computes `priceHash` and the total, and mints `createdAt` — so a client-custody Agent cannot pre-sign a payload it has not seen. Rather than making `create_cart` a two-round-trip handshake, it stays one-shot (ADR-0002): the merchant key commits to the prices immediately, the row stores `agent_signature` NULL, and the Agent signs the returned payload locally and hands that signature to `submit_payment` as `cartSignature`. The trust gate verifies it against the Agent's public key — alongside the Intent signature, the merchant Cart signature, and (client custody only) the Payment signature — before any Order exists, and persists it onto the cart row (NULL → value, under an `IS NULL` guard, inside the order transaction) so every *paid* chain's stored Cart is both-sides-signed exactly like a custodial one.

This is the one sanctioned write to a mandate row's signatures. It only fills a NULL, never rewrites, and rolls back with the Order on any transactional Refusal. An unpaid client-custody Cart remaining agent-unsigned is honest: the Agent never authorized it.

## Considered options

- **Two-step create_cart (propose, then confirm-with-signature)** — rejected: reintroduces a half-created cart state ADR-0002 exists to avoid, and buys nothing the deferred signature doesn't.
- **Skipping the agent-side Cart signature for client custody** (the Payment signature already covers `cartHash`) — rejected: the trust gate's invariant is that the Agent's own key signed the Cart's exact contents; hash-transitivity is an argument, not a signature.
- **Client-side-only custody** — rejected: kills the claude.ai connector demo (that client cannot sign).
- **A custody flag column** — rejected: a flag beside the nullable key column could disagree with it; the NULL is the fact.

## Consequences

- Signature verification at the trust gate is custody-aware in exactly one place (`submitPayment`): custodial reads stored signatures, client custody verifies the supplied Cart and Payment signatures. The Payment mandate's signature is now verified at the gate for client custody (custodially it was just computed by the same process).
- A locally signed mandate whose signature does not verify is a Refusal (`INVALID_MANDATE`, not recoverable), audited before it is thrown — `mandate.refused` at `declare_intent`, the existing `payment.refused` at `submit_payment` — because a bad signature is the trust layer's policy no before money moves, never a validation error.
- The server never signs on a client-custody Agent's behalf, anywhere. A code path that would need to is a design error by definition.
- `agents.private_key` and `cart_mandates.agent_signature` are nullable (migration 0005); everything custodial is untouched — its rows still populate both.
- The architecture doc should state the custody model in these terms; CONTEXT.md carries the glossary entry.
