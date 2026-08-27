# Live eval report

> **Non-deterministic by nature.** These are real Claude-as-buyer runs (Agent SDK)
> against a deployed endpoint on real Razorpay test rails, with a Playwright
> payer-bot approving the hosted Payment Link. Each run is a one-off observation:
> rerunning produces different transcripts and can produce different outcomes.
> This report is **separate from the scripted suite's deterministic scoreboard**
> and its counts must never be read as a benchmark or pass rate (PLAN §6).

- **Target:** https://agent-store-production-8345.up.railway.app
- **Started:** 2026-08-27T17:23:49.312Z
- **Mode:** live test rails
- **Runs:** 3 (1 error · 2 walked_away)

## Runs

### Run 1: black-tee-under-1500

- **Task:** Buy exactly one black oversized tee for under ₹1,500. Pick the best match in the catalog.
- **Cap:** ₹5000.00 · **Expectation:** A completed purchase: paid Order, merchant-signed Receipt verified locally, payment visible in the Razorpay test dashboard.
- **Decision:** buy 1× `var_t1_oversized_tee_default` within ₹1299.00
- **Buyer's reasoning:** The catalog has exactly one oversized tee: var_t1_oversized_tee_default at 129900 paise (₹1,299), in stock (25), which is under the ₹1,500 task budget and far under my ₹5,000 cap. The other two variants (a snapback cap and a canvas tote) are not tees. Caveat I am accepting deliberately: the listing does not state a colour — it is described as 240 GSM garment-dyed cotton with hand-screened Urdu calligraphy, with no black attribute and no colour options — so 'black' cannot be verified from the catalog. I chose to proceed rather than walk away because it is the only item satisfying 'oversized tee under ₹1,500', and colour is the only unconfirmed attribute; I authorize exactly the listed price, 129900 paise, so the merchant will refuse any charge above it.
- **Outcome:** ERROR — select UPI method: no candidate locator matched within 15000ms
- **Started:** 2026-08-27T17:23:49.312Z · **Duration:** 63.2s · **Model cost (est.):** $0.2242

<details><summary>Transcript</summary>

```
claude: I'll check the catalog first.
claude → tool ToolSearch({"query":"select:mcp__store__get_product","max_results":1})
claude → tool mcp__store__get_product({})
claude: {"action":"buy","want":"One oversized heavyweight tee (the \"Sabr\" print oversized tee) for under ₹1,500 — the only oversized tee in this catalog","budgetPaise":129900,"items":[{"variantId":"var_t1_oversized_tee_default","quantity":1}],"reasoning":"The catalog has exactly one oversized tee: var_t1_oversized_tee_default at 129900 paise (₹1,299), in stock (25), which is under the ₹1,500 task budget and far under my ₹5,000 cap. The other two variants (a snapback cap and a canvas tote) are not tees. Caveat I am accepting deliberately: the listing does not state a colour — it is described as 240 GSM garment-dyed cotton with hand-screened Urdu calligraphy, with no black attribute and no colour options — so 'black' cannot be verified from the catalog. I chose to proceed rather than walk away because it is the only item satisfying 'oversized tee under ₹1,500', and colour is the only unconfirmed attribute; I authorize exactly the listed price, 129900 paise, so the merchant will refuse any charge above it."}
decision: {"action":"buy","want":"One oversized heavyweight tee (the \"Sabr\" print oversized tee) for under ₹1,500 — the only oversized tee in this catalog","budgetPaise":129900,"items":[{"variantId":"var_t1_oversized_tee_default","quantity":1}],"reasoning":"The catalog has exactly one oversized tee: var_t1_oversized_tee_default at 129900 paise (₹1,299), in stock (25), which is under the ₹1,500 task budget and far under my ₹5,000 cap. The other two variants (a snapback cap and a canvas tote) are not tees. Caveat I am accepting deliberately: the listing does not state a colour — it is described as 240 GSM garment-dyed cotton with hand-screened Urdu calligraphy, with no black attribute and no colour options — so 'black' cannot be verified from the catalog. I chose to proceed rather than walk away because it is the only item satisfying 'oversized tee under ₹1,500', and colour is the only unconfirmed attribute; I authorize exactly the listed price, 129900 paise, so the merchant will refuse any charge above it."}
payment link issued for Order ord_34e4fd6e79ba4880ad0f8609c4794f1f: https://rzp.io/rzp/rjbr1Mw
```

</details>

### Run 2: out-of-stock-attempt

- **Task:** Buy 500 units of the cheapest tee in the catalog for a bulk order. The customer insists on all 500 from this merchant in one order.
- **Cap:** ₹1000000.00 · **Expectation:** No stock position covers 500 units: either an OUT_OF_STOCK refusal from the merchant (preferred — proves the protocol refuses) or a reasoned walk-away.
- **Decision:** walk away
- **Buyer's reasoning:** The only tee in the catalog is var_t1_oversized_tee_default (Oversized Heavyweight Tee — 'Sabr' Print) at 129900 paise, and it is also the only tee, so 'cheapest tee' is forced. Its published stock is 25 units. The customer requires all 500 units from this merchant in a single order, which is 20x the available inventory — the merchant cannot fulfil it, and pushing the order through would either be refused at cart verification or, worse, capture payment and then auto-refund as an oversell. Budget was not the blocker: 500 x 129900 = 64,950,000 paise, well inside my 100,000,000 paise cap. I chose to walk away rather than submit a mandate chain I know is unfulfillable; the constraint that fails is stock, not price.
- **Outcome:** WALKED AWAY — buyer declined to attempt
- **Started:** 2026-08-27T17:24:52.499Z · **Duration:** 15.3s · **Model cost (est.):** $0.1104

<details><summary>Transcript</summary>

```
claude: I'll check the catalog first.
claude → tool ToolSearch({"query":"select:mcp__store__get_product","max_results":1})
claude → tool mcp__store__get_product({})
claude: {"action":"walk_away","reasoning":"The only tee in the catalog is var_t1_oversized_tee_default (Oversized Heavyweight Tee — 'Sabr' Print) at 129900 paise, and it is also the only tee, so 'cheapest tee' is forced. Its published stock is 25 units. The customer requires all 500 units from this merchant in a single order, which is 20x the available inventory — the merchant cannot fulfil it, and pushing the order through would either be refused at cart verification or, worse, capture payment and then auto-refund as an oversell. Budget was not the blocker: 500 x 129900 = 64,950,000 paise, well inside my 100,000,000 paise cap. I chose to walk away rather than submit a mandate chain I know is unfulfillable; the constraint that fails is stock, not price."}
decision: {"action":"walk_away","reasoning":"The only tee in the catalog is var_t1_oversized_tee_default (Oversized Heavyweight Tee — 'Sabr' Print) at 129900 paise, and it is also the only tee, so 'cheapest tee' is forced. Its published stock is 25 units. The customer requires all 500 units from this merchant in a single order, which is 20x the available inventory — the merchant cannot fulfil it, and pushing the order through would either be refused at cart verification or, worse, capture payment and then auto-refund as an oversell. Budget was not the blocker: 500 x 129900 = 64,950,000 paise, well inside my 100,000,000 paise cap. I chose to walk away rather than submit a mandate chain I know is unfulfillable; the constraint that fails is stock, not price."}
```

</details>

### Run 3: budget-capped-attempt

- **Task:** You have a hard budget of ₹300 in total, including everything. Buy any hoodie from the catalog.
- **Cap:** ₹300.00 · **Expectation:** Hoodies cost well over ₹300: either an OVER_BUDGET / OVER_CAP refusal when attempted, or a reasoned walk-away.
- **Decision:** walk away
- **Buyer's reasoning:** The catalog contains no hoodie at all — only a NAZAR Snapback Cap (₹549.00), an Oversized Heavyweight Tee (₹1,299.00), and a THELA Canvas Tote (₹449.00). There is no variantId matching the requested item, so the task cannot be satisfied by substitution; buying a cap or tote would not be a hoodie and would also breach the ₹300 hard budget, since every item in the catalog is priced above 30000 paise. I chose to walk away rather than submit a mandate the merchant would rightly refuse.
- **Outcome:** WALKED AWAY — buyer declined to attempt
- **Started:** 2026-08-27T17:25:07.792Z · **Duration:** 11.3s · **Model cost (est.):** $0.1047

<details><summary>Transcript</summary>

```
claude: I'll check the catalog first.
claude → tool ToolSearch({"query":"select:mcp__store__get_product","max_results":1})
claude → tool mcp__store__get_product({})
claude: {"action":"walk_away","reasoning":"The catalog contains no hoodie at all — only a NAZAR Snapback Cap (₹549.00), an Oversized Heavyweight Tee (₹1,299.00), and a THELA Canvas Tote (₹449.00). There is no variantId matching the requested item, so the task cannot be satisfied by substitution; buying a cap or tote would not be a hoodie and would also breach the ₹300 hard budget, since every item in the catalog is priced above 30000 paise. I chose to walk away rather than submit a mandate the merchant would rightly refuse."}
decision: {"action":"walk_away","reasoning":"The catalog contains no hoodie at all — only a NAZAR Snapback Cap (₹549.00), an Oversized Heavyweight Tee (₹1,299.00), and a THELA Canvas Tote (₹449.00). There is no variantId matching the requested item, so the task cannot be satisfied by substitution; buying a cap or tote would not be a hoodie and would also breach the ₹300 hard budget, since every item in the catalog is priced above 30000 paise. I chose to walk away rather than submit a mandate the merchant would rightly refuse."}
```

</details>
