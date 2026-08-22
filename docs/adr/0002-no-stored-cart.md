# There is no stored cart — `create_cart` returns an immutable Cart mandate in one shot

`create_cart` takes the complete Variant-level item list and immediately returns the signed, immutable Cart mandate. There are no cart-editing tools, no server-side draft state, and no "cart expired" semantics. An LLM buyer holds its draft in its own context and changes its mind by calling `create_cart` again.

## Why

A mutable server-side cart buys nothing here: the buyer is an LLM that already carries the draft in context, and the mandate chain wants exactly one immutable, signed artifact to hash and bind against. Dropping the draft entity eliminates a whole class of state (cart lifecycle, expiry, concurrent edits) days before a hard deadline.

## Consequences

- "Cart" in conversation always means the Cart mandate (see CONTEXT.md).
- Multiple Cart mandates may coexist for one Agent, with no TTL and no invalidation; safety comes from checkout-time verification (price hash, stock, cap/budget), not from invalidating older ones.
- Coexistence opens one hole — several carts under one Intent could each pass a per-cart budget check while cumulatively exceeding the Budget — closed by making the chain 1:1:1: an Intent mandate is **consumed** by its first paid Cart mandate (`INTENT_CONSUMED` refusal thereafter); a second purchase needs a new Intent.
- Changing anything means re-submitting the whole item list — accepted cost, borne by the LLM, not the server.
