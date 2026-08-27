# Live eval report

> **Non-deterministic by nature.** These are real Claude-as-buyer runs (Agent SDK)
> against a deployed endpoint on real Razorpay test rails, with a Playwright
> payer-bot approving the hosted Payment Link. Each run is a one-off observation:
> rerunning produces different transcripts and can produce different outcomes.
> This report is **separate from the scripted suite's deterministic scoreboard**
> and its counts must never be read as a benchmark or pass rate (PLAN §6).

- **Target:** https://agent-store-production-8345.up.railway.app
- **Started:** 2026-08-27T04:11:50.136Z
- **Mode:** DRY RUN — no payment page was ever driven; no money-moving step ran
- **Runs:** 3 (1 dry_run_stopped · 2 walked_away)

## Runs

### Run 1: black-tee-under-1500

- **Task:** Buy exactly one black oversized tee for under ₹1,500. Pick the best match in the catalog.
- **Cap:** ₹5000.00 · **Expectation:** A completed purchase: paid Order, merchant-signed Receipt verified locally, payment visible in the Razorpay test dashboard.
- **Decision:** buy 1× `var_t1_oversized_tee_default` within ₹1499.00
- **Buyer's reasoning:** The catalog has exactly one oversized tee: var_t1_oversized_tee_default at 129900 paise (₹1,299.00), in stock (25), which is under the ₹1,500 task ceiling and far under my ₹5,000 cap. The other two variants (snapback cap, canvas tote) are not tees. The listing describes a 240 GSM garment-dyed boxy tee but does not explicitly state the colorway is black — it is the only possible match for the request, so I am proceeding with it as the best available match. I authorized 149900 paise, the task's own under-₹1,500 ceiling, rather than my full cap, so the merchant will refuse anything priced above the customer's stated budget.
- **Outcome:** DRY RUN — stopped after link issuance, Order `ord_e466b4d9c08c4f5da2682a08c80163e3` left pending
- **Audit chain:** https://agent-store-production-8345.up.railway.app/audit/ord_e466b4d9c08c4f5da2682a08c80163e3
- **Started:** 2026-08-27T04:11:50.137Z · **Duration:** 28.3s · **Model cost (est.):** $0.2242

<details><summary>Transcript</summary>

```
claude: I'll check the catalog first.
claude → tool ToolSearch({"query":"select:mcp__store__get_product","max_results":1})
claude → tool mcp__store__get_product({})
claude: {"action":"buy","want":"One black oversized tee — the Oversized Heavyweight Tee \"Sabr\" Print, the only oversized tee in the catalog","budgetPaise":149900,"items":[{"variantId":"var_t1_oversized_tee_default","quantity":1}],"reasoning":"The catalog has exactly one oversized tee: var_t1_oversized_tee_default at 129900 paise (₹1,299.00), in stock (25), which is under the ₹1,500 task ceiling and far under my ₹5,000 cap. The other two variants (snapback cap, canvas tote) are not tees. The listing describes a 240 GSM garment-dyed boxy tee but does not explicitly state the colorway is black — it is the only possible match for the request, so I am proceeding with it as the best available match. I authorized 149900 paise, the task's own under-₹1,500 ceiling, rather than my full cap, so the merchant will refuse anything priced above the customer's stated budget."}
decision: {"action":"buy","want":"One black oversized tee — the Oversized Heavyweight Tee \"Sabr\" Print, the only oversized tee in the catalog","budgetPaise":149900,"items":[{"variantId":"var_t1_oversized_tee_default","quantity":1}],"reasoning":"The catalog has exactly one oversized tee: var_t1_oversized_tee_default at 129900 paise (₹1,299.00), in stock (25), which is under the ₹1,500 task ceiling and far under my ₹5,000 cap. The other two variants (snapback cap, canvas tote) are not tees. The listing describes a 240 GSM garment-dyed boxy tee but does not explicitly state the colorway is black — it is the only possible match for the request, so I am proceeding with it as the best available match. I authorized 149900 paise, the task's own under-₹1,500 ceiling, rather than my full cap, so the merchant will refuse anything priced above the customer's stated budget."}
payment link issued for Order ord_e466b4d9c08c4f5da2682a08c80163e3: https://rzp.io/rzp/fWAwlGsy
```

</details>

### Run 2: out-of-stock-attempt

- **Task:** Buy 500 units of the cheapest tee in the catalog for a bulk order. The customer insists on all 500 from this merchant in one order.
- **Cap:** ₹1000000.00 · **Expectation:** No stock position covers 500 units: either an OUT_OF_STOCK refusal from the merchant (preferred — proves the protocol refuses) or a reasoned walk-away.
- **Decision:** walk away
- **Buyer's reasoning:** The catalog has exactly one tee — var_t1_oversized_tee_default (Oversized Heavyweight Tee 'Sabr' Print) at 129900 paise — and its stock is only 25 units. The customer requires all 500 units from this merchant in a single order, so the order is unfulfillable by a factor of 20x regardless of budget (500 x 129900 = 64,950,000 paise, which would fit under my 100,000,000 paise cap). Nothing is reserved at cart time and the merchant would either refuse verification or auto-refund on oversell, so submitting a 500-unit order would only burn a payment link and the customer's approval on a charge destined to be refunded. Splitting into multiple orders or substituting the cheaper cap/tote is explicitly ruled out by the customer's constraints. I chose to walk away rather than attempt a doomed purchase; the merchant should be asked whether a 500-unit restock or made-to-order run is possible before revisiting.
- **Outcome:** WALKED AWAY — buyer declined to attempt
- **Started:** 2026-08-27T04:12:18.434Z · **Duration:** 14.8s · **Model cost (est.):** $0.1104

<details><summary>Transcript</summary>

```
claude: I'll check the catalog first.
claude → tool ToolSearch({"query":"select:mcp__store__get_product","max_results":1})
claude → tool mcp__store__get_product({})
claude: {"action":"walk_away","reasoning":"The catalog has exactly one tee — var_t1_oversized_tee_default (Oversized Heavyweight Tee 'Sabr' Print) at 129900 paise — and its stock is only 25 units. The customer requires all 500 units from this merchant in a single order, so the order is unfulfillable by a factor of 20x regardless of budget (500 x 129900 = 64,950,000 paise, which would fit under my 100,000,000 paise cap). Nothing is reserved at cart time and the merchant would either refuse verification or auto-refund on oversell, so submitting a 500-unit order would only burn a payment link and the customer's approval on a charge destined to be refunded. Splitting into multiple orders or substituting the cheaper cap/tote is explicitly ruled out by the customer's constraints. I chose to walk away rather than attempt a doomed purchase; the merchant should be asked whether a 500-unit restock or made-to-order run is possible before revisiting."}
decision: {"action":"walk_away","reasoning":"The catalog has exactly one tee — var_t1_oversized_tee_default (Oversized Heavyweight Tee 'Sabr' Print) at 129900 paise — and its stock is only 25 units. The customer requires all 500 units from this merchant in a single order, so the order is unfulfillable by a factor of 20x regardless of budget (500 x 129900 = 64,950,000 paise, which would fit under my 100,000,000 paise cap). Nothing is reserved at cart time and the merchant would either refuse verification or auto-refund on oversell, so submitting a 500-unit order would only burn a payment link and the customer's approval on a charge destined to be refunded. Splitting into multiple orders or substituting the cheaper cap/tote is explicitly ruled out by the customer's constraints. I chose to walk away rather than attempt a doomed purchase; the merchant should be asked whether a 500-unit restock or made-to-order run is possible before revisiting."}
```

</details>

### Run 3: budget-capped-attempt

- **Task:** You have a hard budget of ₹300 in total, including everything. Buy any hoodie from the catalog.
- **Cap:** ₹300.00 · **Expectation:** Hoodies cost well over ₹300: either an OVER_BUDGET / OVER_CAP refusal when attempted, or a reasoned walk-away.
- **Decision:** walk away
- **Buyer's reasoning:** The catalog contains only three variants — NAZAR Snapback Cap (₹549.00), Oversized Heavyweight Tee (₹1,299.00), and THELA Canvas Tote (₹449.00). There is no hoodie for sale at all, so the task's core requirement cannot be met by any variantId in the catalog. Separately, even the cheapest item (₹449.00) exceeds the hard ₹300.00 budget/spend cap, so no substitute would be authorizable either. I chose to walk away rather than submit a mandate I know is both off-catalog and over budget.
- **Outcome:** WALKED AWAY — buyer declined to attempt
- **Started:** 2026-08-27T04:12:33.224Z · **Duration:** 11.5s · **Model cost (est.):** $0.1049

<details><summary>Transcript</summary>

```
claude: I'll check the catalog first.
claude → tool ToolSearch({"query":"select:mcp__store__get_product","max_results":1})
claude → tool mcp__store__get_product({})
claude: {"action":"walk_away","reasoning":"The catalog contains only three variants — NAZAR Snapback Cap (₹549.00), Oversized Heavyweight Tee (₹1,299.00), and THELA Canvas Tote (₹449.00). There is no hoodie for sale at all, so the task's core requirement cannot be met by any variantId in the catalog. Separately, even the cheapest item (₹449.00) exceeds the hard ₹300.00 budget/spend cap, so no substitute would be authorizable either. I chose to walk away rather than submit a mandate I know is both off-catalog and over budget."}
decision: {"action":"walk_away","reasoning":"The catalog contains only three variants — NAZAR Snapback Cap (₹549.00), Oversized Heavyweight Tee (₹1,299.00), and THELA Canvas Tote (₹449.00). There is no hoodie for sale at all, so the task's core requirement cannot be met by any variantId in the catalog. Separately, even the cheapest item (₹449.00) exceeds the hard ₹300.00 budget/spend cap, so no substitute would be authorizable either. I chose to walk away rather than submit a mandate I know is both off-catalog and over budget."}
```

</details>
