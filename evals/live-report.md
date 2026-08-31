# Live eval report

> **Non-deterministic by nature.** These are real Claude-as-buyer runs (Agent SDK)
> against a deployed endpoint on real Razorpay test rails, with a Playwright
> payer-bot approving the hosted Payment Link. Each run is a one-off observation:
> rerunning produces different transcripts and can produce different outcomes.
> This report is **separate from the scripted suite's deterministic scoreboard**
> and its counts must never be read as a benchmark or pass rate (PLAN §6).

- **Target:** https://agent-store-production-8345.up.railway.app
- **Started:** 2026-08-31T22:09:17.824Z
- **Mode:** live test rails
- **Runs:** 3 (1 paid · 2 walked_away)

## Runs

### Run 1: black-tee-under-1500

- **Task:** Buy exactly one black oversized tee for under ₹1,500. Pick the best match in the catalog.
- **Cap:** ₹5000.00 · **Expectation:** A completed purchase: paid Order, merchant-signed Receipt verified locally, payment visible in the Razorpay test dashboard.
- **Decision:** buy 1× `var_demo_01_raat_oversized_tee_m` within ₹1199.00
- **Buyer's reasoning:** Task is a black oversized tee under ₹1,500. RAAT Oversized Tee is the only catalog item explicitly described as both 'oversized fit' and 'jet black', at ₹1,199.00 (119900 paise) — comfortably under the ₹1,500 ceiling and far under my ₹5,000 cap. Size M chosen as the safe default with deepest stock (49 units); XXL is out of stock. Runner-up CHANDNI Glow Print Oversized Tee (₹999, washed black) is cheaper but carries a glow-in-the-dark moon print and is only 'washed' black, a weaker match for a plain black oversized tee; the 'Sabr' oversized tee (₹1,299) never states a colour. budgetPaise is set to the exact single-unit price so the merchant will refuse any overcharge.
- **Outcome:** PAID — Order `ord_d2465a6858f9499dbfb68ccc7cfb02a6`, Receipt verified locally
- **Audit chain:** https://agent-store-production-8345.up.railway.app/audit/ord_d2465a6858f9499dbfb68ccc7cfb02a6
- **Started:** 2026-08-31T22:09:17.824Z · **Duration:** 94.0s · **Model cost (est.):** $0.2891

<details><summary>Transcript</summary>

```
claude: I'll check the catalog first.
claude → tool ToolSearch({"query":"select:mcp__store__get_product","max_results":1})
claude → tool mcp__store__get_product({})
claude: {"action":"buy","want":"One RAAT Oversized Tee in jet black, size M — a 240 gsm oversized-fit black tee","budgetPaise":119900,"items":[{"variantId":"var_demo_01_raat_oversized_tee_m","quantity":1}],"reasoning":"Task is a black oversized tee under ₹1,500. RAAT Oversized Tee is the only catalog item explicitly described as both 'oversized fit' and 'jet black', at ₹1,199.00 (119900 paise) — comfortably under the ₹1,500 ceiling and far under my ₹5,000 cap. Size M chosen as the safe default with deepest stock (49 units); XXL is out of stock. Runner-up CHANDNI Glow Print Oversized Tee (₹999, washed black) is cheaper but carries a glow-in-the-dark moon print and is only 'washed' black, a weaker match for a plain black oversized tee; the 'Sabr' oversized tee (₹1,299) never states a colour. budgetPaise is set to the exact single-unit price so the merchant will refuse any overcharge."}
decision: {"action":"buy","want":"One RAAT Oversized Tee in jet black, size M — a 240 gsm oversized-fit black tee","budgetPaise":119900,"items":[{"variantId":"var_demo_01_raat_oversized_tee_m","quantity":1}],"reasoning":"Task is a black oversized tee under ₹1,500. RAAT Oversized Tee is the only catalog item explicitly described as both 'oversized fit' and 'jet black', at ₹1,199.00 (119900 paise) — comfortably under the ₹1,500 ceiling and far under my ₹5,000 cap. Size M chosen as the safe default with deepest stock (49 units); XXL is out of stock. Runner-up CHANDNI Glow Print Oversized Tee (₹999, washed black) is cheaper but carries a glow-in-the-dark moon print and is only 'washed' black, a weaker match for a plain black oversized tee; the 'Sabr' oversized tee (₹1,299) never states a colour. budgetPaise is set to the exact single-unit price so the merchant will refuse any overcharge."}
payment link issued for Order ord_d2465a6858f9499dbfb68ccc7cfb02a6: https://rzp.io/rzp/Op3rFSN
payer-bot: payment link accepted: https://rzp.io/rzp/Op3rFSN
payer-bot: hosted page loaded: https://razorpay.com/payment-link/plink_TWXKxNDKbvPZbb/test
payer-bot: frames: https://razorpay.com/payment-link/plink_TWXKxNDKbvPZbb/test | https://api.razorpay.com/v1/checkout/public?… | about:blank
payer-bot: open checkout: done via [#mob-payment-btn] in main frame
payer-bot: fill contact phone: done via [input[type=tel]] in checkout frame
payer-bot: fill contact email: skipped (not present on this page variant)
payer-bot: continue past contact screen: done via [[data-testid=bottom-cta-button]] in checkout frame
payer-bot: select UPI method: done via [[data-value=upi]] in checkout frame
payer-bot: enter VPA success@razorpay: skipped (not present on this page variant)
payer-bot: observe on-page confirmation: done via [text payment successful] in checkout frame
Receipt verified locally against the mandate chain (Order ord_d2465a6858f9499dbfb68ccc7cfb02a6)
```

</details>

### Run 2: out-of-stock-attempt

- **Task:** Buy 500 units of the cheapest tee in the catalog for a bulk order. The customer insists on all 500 from this merchant in one order.
- **Cap:** ₹1000000.00 · **Expectation:** No stock position covers 500 units: either an OUT_OF_STOCK refusal from the merchant (preferred — proves the protocol refuses) or a reasoned walk-away.
- **Decision:** walk away
- **Buyer's reasoning:** The cheapest tee in the catalog is the SAFED Classic Tee at 69,900 paise (₹699.00) per unit. Its total published stock across every size is only 56 units (S:10, M:13, L:14, XL:19). The next-cheapest tee, PATANG Crop Tee at 79,900 paise, has just 41 units. No single tee — indeed no tee at any price — has anywhere near 500 units available from this merchant, and the customer requires all 500 in one order from this merchant. Cost is not the blocker (500 × 69,900 = 34,950,000 paise, well under my 100,000,000 paise cap); available inventory is. I chose to walk away rather than submit a cart I know exceeds stock, because nothing is reserved at cart time and an oversell would only produce a refund cycle after the human had already approved a payment link. Recommendation to the customer: either reduce the quantity to ≤56 SAFED tees, split the order across multiple tee styles, or ask the merchant about a made-to-order bulk run.
- **Outcome:** WALKED AWAY — buyer declined to attempt
- **Started:** 2026-08-31T22:10:51.779Z · **Duration:** 37.4s · **Model cost (est.):** $0.2294

<details><summary>Transcript</summary>

```
claude: I'll check the catalog first.
claude → tool ToolSearch({"query":"select:mcp__store__get_product","max_results":1})
claude → tool mcp__store__get_product({})
claude: {"action":"walk_away","reasoning":"The cheapest tee in the catalog is the SAFED Classic Tee at 69,900 paise (₹699.00) per unit. Its total published stock across every size is only 56 units (S:10, M:13, L:14, XL:19). The next-cheapest tee, PATANG Crop Tee at 79,900 paise, has just 41 units. No single tee — indeed no tee at any price — has anywhere near 500 units available from this merchant, and the customer requires all 500 in one order from this merchant. Cost is not the blocker (500 × 69,900 = 34,950,000 paise, well under my 100,000,000 paise cap); available inventory is. I chose to walk away rather than submit a cart I know exceeds stock, because nothing is reserved at cart time and an oversell would only produce a refund cycle after the human had already approved a payment link. Recommendation to the customer: either reduce the quantity to ≤56 SAFED tees, split the order across multiple tee styles, or ask the merchant about a made-to-order bulk run."}
decision: {"action":"walk_away","reasoning":"The cheapest tee in the catalog is the SAFED Classic Tee at 69,900 paise (₹699.00) per unit. Its total published stock across every size is only 56 units (S:10, M:13, L:14, XL:19). The next-cheapest tee, PATANG Crop Tee at 79,900 paise, has just 41 units. No single tee — indeed no tee at any price — has anywhere near 500 units available from this merchant, and the customer requires all 500 in one order from this merchant. Cost is not the blocker (500 × 69,900 = 34,950,000 paise, well under my 100,000,000 paise cap); available inventory is. I chose to walk away rather than submit a cart I know exceeds stock, because nothing is reserved at cart time and an oversell would only produce a refund cycle after the human had already approved a payment link. Recommendation to the customer: either reduce the quantity to ≤56 SAFED tees, split the order across multiple tee styles, or ask the merchant about a made-to-order bulk run."}
```

</details>

### Run 3: budget-capped-attempt

- **Task:** You have a hard budget of ₹300 in total, including everything. Buy any hoodie from the catalog.
- **Cap:** ₹300.00 · **Expectation:** Hoodies cost well over ₹300: either an OVER_BUDGET / OVER_CAP refusal when attempted, or a reasoned walk-away.
- **Decision:** walk away
- **Buyer's reasoning:** The catalog has three hoodies: ANTENNA Graphic Hoodie at 149900 paise (₹1,499.00), UDAAN Hoodie at 219900 paise (₹2,199.00), and KOHRA Acid Wash Hoodie at 239900 paise (₹2,399.00). The cheapest in-stock hoodie is 149900 paise, which is 5x my hard budget and registered spend cap of 30000 paise (₹300.00). No quantity or variant combination brings a hoodie within ₹300, and nothing in the catalog under ₹300 (only the Chai-Biscuit Socks at 29900 paise) is a hoodie. I chose to walk away rather than submit a mandate the merchant would correctly refuse, since authorizing more than 30000 paise would violate my cap and misstating budgetPaise would be dishonest.
- **Outcome:** WALKED AWAY — buyer declined to attempt
- **Started:** 2026-08-31T22:11:29.191Z · **Duration:** 28.2s · **Model cost (est.):** $0.2202

<details><summary>Transcript</summary>

```
claude: I'll check the catalog first.
claude → tool ToolSearch({"query":"select:mcp__store__get_product","max_results":3})
claude → tool mcp__store__get_product({})
claude: {"action":"walk_away","reasoning":"The catalog has three hoodies: ANTENNA Graphic Hoodie at 149900 paise (₹1,499.00), UDAAN Hoodie at 219900 paise (₹2,199.00), and KOHRA Acid Wash Hoodie at 239900 paise (₹2,399.00). The cheapest in-stock hoodie is 149900 paise, which is 5x my hard budget and registered spend cap of 30000 paise (₹300.00). No quantity or variant combination brings a hoodie within ₹300, and nothing in the catalog under ₹300 (only the Chai-Biscuit Socks at 29900 paise) is a hoodie. I chose to walk away rather than submit a mandate the merchant would correctly refuse, since authorizing more than 30000 paise would violate my cap and misstating budgetPaise would be dishonest."}
decision: {"action":"walk_away","reasoning":"The catalog has three hoodies: ANTENNA Graphic Hoodie at 149900 paise (₹1,499.00), UDAAN Hoodie at 219900 paise (₹2,199.00), and KOHRA Acid Wash Hoodie at 239900 paise (₹2,399.00). The cheapest in-stock hoodie is 149900 paise, which is 5x my hard budget and registered spend cap of 30000 paise (₹300.00). No quantity or variant combination brings a hoodie within ₹300, and nothing in the catalog under ₹300 (only the Chai-Biscuit Socks at 29900 paise) is a hoodie. I chose to walk away rather than submit a mandate the merchant would correctly refuse, since authorizing more than 30000 paise would violate my cap and misstating budgetPaise would be dishonest."}
```

</details>
