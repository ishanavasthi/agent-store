# Demo dataset (T11)

The demo merchant's raw catalog — **Kalaakar Streetwear**, a fictional Indian D2C
streetwear brand, 28 products. This is what the M4 ingestion pipeline (T12) is fed and
what its accuracy is measured against: `dataset.json` holds, per product, the photo, the
messy Instagram-style caption, and the hand-labeled ground truth. Published in-repo for
the same reason the spike labels are (`fixtures/extraction-spike/`): the metrics must not
be the project grading its own homework.

This is the *demo catalog* promised by `PLAN.md` §5.3. It is separate from the 5-item
spike dataset, which was a go/no-go gate; none of the 28 products here repeat a spike
product, and per-field accuracy on *this* set is the reportable number.

## Authorship — read before trusting the captions

The captions and labels were authored by the AI assistant that built this dataset (T11),
written by hand in the style of the five human-written spike captions — no model API
generated any caption or label text. The spec's intent ("caption messiness is the test
payload, never generated") is that captions read like a real merchant typed them;
**flagging for human review before release**: a human should skim the captions for tells
before this dataset is cited in a demo or the captions are held up as human-written.
The photos are generated (see below) and were always going to be.

## Files

- `dataset.json` — captions + labels, one entry per product (same shape as the spike's,
  extended — see schema below).
- `images/<id>.jpg` — one product shot per item, 768px JPEG.
- `generate-images.mjs` — the exact script and prompts the committed images came from
  (`gpt-image-1`, quality medium, 1024×1024, downscaled with `sips`). Provenance, and
  the way to regenerate any image. Requires `OPENAI_API_KEY`; live billed call, not part
  of `npm test`.
- `29-tapri-half-zip/` — the **29th caption** (S1.4, plan D14): a video prop, not a dataset
  item. No ground-truth label, not scored, deliberately outside `dataset.json` so the
  committed accuracy numbers stay about the 28. See its own README for why it is worded the
  way it is.
- `runs/<model>.json` (OpenAI) / `runs/<provider>-<model>-<outputMode>.json`
  (everything else) — committed accuracy runs, written by `npm run ingest:accuracy`
  (T12): per-field scores vs these labels, every raw model response, the threshold sweep
  `AUTO_PUBLISH_THRESHOLD` is tuned on, and what the lifecycle gate published vs held.
  Same argument as the spike's `runs/`: every accuracy number the repo claims is read off
  a committed record, and `src/ingestion/demoRun.test.ts` pins it in CI.

## Model comparison (S2.3, 2026-09-03)

Which model runs extraction in the demo was decided by measurement, not by
preference. Every number below is read off a committed record in `runs/`;
reproduce the table with `npm run ingest:compare`.

**The ranking rule, in order:** `publishedWithWrongField` must be empty first —
a model that auto-publishes a field the hand labels call wrong is disqualified
however good its averages look — then per-field accuracy, then latency.

```
model               provider    mode         name  price  stock  variantLabels  descriptionPresence  variantStock  pub/held  wrongPublished  elapsed
------------------  ----------  -----------  ----  -----  -----  -------------  -------------------  ------------  --------  --------------  -------
gpt-5-mini          openai      json_schema  96%   100%   100%   100%           100%                 100%          3/25      0               169s
z-ai/glm-5.3-flash  openrouter  tool_call    93%   100%   96%    100%           100%                 100%          2/26      1               239s
```

Four OpenRouter runs were planned (two models × two output modes). Two of them
produced no record, and that is a result, not a gap:

| run | outcome |
|---|---|
| `z-ai/glm-5.3-flash` × `tool_call` | **completed**, record committed. Meets the 70% floor on every reportable field — and **disqualified**: it auto-published `23-machli-mesh-shorts` with a product stock of 13, the sum of the per-variant split `{S: 4, M: 7, L: 2}` that the caption never totals, at confidence 0.90. An invented number in the one column checkout trusts. |
| `z-ai/glm-5.3-flash` × `json_schema` | **no record.** Three attempts, each reaching item 23 of 28 and stopping there: once on the adapter's token cap, twice on a request timeout at 120 s and 300 s. Same item, same model, same mode. |
| `minimax/minimax-m3:free` — **both modes, root cause corrected 2026-09-03** | OpenRouter declares `structured_outputs: **false**` for the `:free` variant and `true` for the paid `minimax/minimax-m3`. The free tier lacks the capability outright, which is why `response_format` and a forced `strict` tool call were both ignored. A paid `minimax-m3` × `json_schema` smoke returned correct, fully-enveloped payloads on items 1–2 — so the model can honour the schema. It is still not viable: item 3 returned a 200 with **empty content** (`finish_reason: 'stop'`), which `providerHttp` does not retry and which aborts the run. |
| `minimax/minimax-m3:free` × `tool_call` | **no record.** Failed on item 1: `variantLabels` came back as a bare `["S","M",…]` instead of `{value, confidence}`, under a *forced, strict* tool call. |
| `minimax/minimax-m3:free` × `json_schema` | **no record.** Failed on item 1: the object arrived wrapped in a markdown fence, under a `response_format` that is supposed to make that impossible. |

MiniMax was dropped after 4 smoke requests rather than 56 billed ones — that is
what `npm run ingest:smoke -- --items=3` exists for. The mechanism behind both
of its failures, and behind the timing traps above, is in
`docs/engineering-log.md` under `2026-09-03 — S2.3`.

**The finding.** No OpenRouter configuration currently clears the first rule.
The only record in this directory with `publishedWithWrongField = []` is
`gpt-5-mini.json`, and that key is out of credits. The choice between topping it
up and shipping GLM `tool_call` with a known-bad item is the owner's; the
numbers for it are here.

**Two things this table is evidence *for*, beyond the ranking.** OpenRouter
forwards `response_format` and `strict: true` and enforces neither — GLM
honoured both through the same adapter and the same bytes that MiniMax ignored
— so our zod validation is not a second line of defence behind a provider
guarantee, it is the only guarantee (`DECISIONS.md`, 2026-09-03). And the
per-field `{value, confidence}` envelope is what made MiniMax's drift *loud*: a
bare `variantLabels: string[]` schema would have accepted that payload and put
an unconfirmed size list into the catalog.

## `openai/gpt-5-mini` via OpenRouter — three runs (coordinator, 2026-09-03)

Run after the S2.3 ticket merged, to answer one question: is the §8 gate
(`publishedWithWrongField = []`) measuring model quality, or one item's confidence jitter?
Three consecutive 28-item runs, `openai/gpt-5-mini` × `json_schema` over OpenRouter's
Chat Completions path. Record committed: `runs/openrouter-openai-gpt-5-mini-json-schema.json`
(the third run; the first two differed only as noted).

| | run 1 | run 2 | run 3 |
|---|---|---|---|
| name | 26/28 | 24/28 | 25/28 |
| price | **28/28** | **28/28** | **28/28** |
| stock | **28/28** | **28/28** | **28/28** |
| variantLabels | **28/28** | **28/28** | **28/28** |
| variantStock | **28/28** | **28/28** | **28/28** |
| descriptionPresence | **28/28** | **28/28** | **28/28** |
| published | 4 | 3 | 3 |
| §8 gate | FAIL | FAIL | FAIL |
| published carrying a wrong field | `19-crossbody-sling-bag` | `10-thela-tote-bag` | `10-thela-tote-bag` |
| elapsed | 255 s | 288 s | 283 s |

**Every wrong field in all three runs is a `name`. Nine name misses; zero misses on anything
else — 140/140 on price, stock, variantLabels, variantStock and description presence.**

And every one of those name misses is a near-miss synonym, not an invention:

| item | expected | returned | conf |
|---|---|---|---|
| `24-jalebi-tie-dye-tee` | `JALEBI Tie-Dye Tee` | `JALEBI Tie-Dye T-Shirt` | 0.90–0.95 |
| `10-thela-tote-bag` | `THELA Canvas Tote` | `THELA Tote Bag` | 0.90–0.95 |
| `19-crossbody-sling-bag` | `Crossbody Sling Bag` | `Sling Bag` | 0.85–0.90 |
| `28-chandni-glow-tee` | `CHANDNI Glow Print Oversized Tee` | `Chandni Oversized Tee` | 0.90 |

Two of these are the dataset's own hardest name traps: 19's caption never says what the product
is (the name has to come from the photo), and 10 has no variants stated. `Tee` vs `T-Shirt` is
scored a miss by exact string match and is not an error a buyer would notice.

**So the gate does not separate model quality here — it separates naming pedantry.** Compare the
two disqualifications side by side:

- GLM × `tool_call` published `23-machli-mesh-shorts` with **stock 13**, a total it computed by
  summing a per-variant split the caption never totals. An invented number in the one column
  checkout trusts.
- gpt-5-mini published `THELA Tote Bag` instead of `THELA Canvas Tote`.

`publishedWithWrongField` records those as the same failure. They are not. Restricted to the
fields that move money or inventory — price, stock, variantStock, variantLabels — gpt-5-mini via
OpenRouter is **clean in 3 of 3 runs**, and GLM is not.

Note the committed `runs/gpt-5-mini.json` (OpenAI Responses path) shows
`publishedWithWrongField: []` with name 27/28 — the same model, the same weak field, but the one
wrong name happened to land at confidence 0.70 and was held. Against three fresh runs at
0.85–0.95, that `[]` reads as the lucky tail of one distribution rather than a property of the
Responses API.

## Label schema

The spike's label schema, extended with the two fields T11 requires:

```jsonc
{
  "name": "GALLI Cargo Pants",     // short listing title; from the photo when the caption doesn't say
  "pricePaise": 189900,            // integer paise; the price a buyer actually pays
  "stock": null,                   // product-level count if stated, else null
  "variantLabels": ["28", "30"],   // size/colour options offered as choices; [] = one implicit default Variant
  "variantStock": { "32": 3 },     // per-variant counts, only where the caption states one; {} otherwise
  "description": "…"               // 1–2 sentences a careful merchant would list, from caption + photo facts only
}
```

## Labeling rules

Same philosophy as the spike — a human-style careful reading of caption + photo together,
recording the answer a buyer's money depends on. Labels were written before any model ran
on this dataset and none will be adjusted to match model output.

- **price** is what a buyer pays: the selling price, never a struck-through MRP, a
  pre-discount price, a free-shipping threshold, a COD eligibility limit, a COD
  surcharge, or another product's price mentioned in passing.
- **stock** is `null` unless the caption states a product-level count. Vibes
  (`restocked ✅`, "selling fast", "limited pieces") are `null`. Per-variant counts stay
  in `variantStock` and are **not summed** into product stock — a total the caption never
  states would be an inference, not a label (see `23-machli-mesh-shorts`). A stated total
  across variants ("30 pcs total dono colour mila ke") *is* product stock.
- **variantLabels** are choices. "free size" / "one size" / "adjustable" is the absence
  of a choice → `[]` → one implicit default Variant (see CONTEXT.md → Variant). Colours
  that are the *contents* of a pack, not options, are also not variants
  (`13-chai-biscuit-socks`).
- **name** comes from the caption when it names the product, from the photo when it
  doesn't (`19-crossbody-sling-bag`).
- **description** sticks to facts stated in the caption or plainly visible in the photo;
  it never invents materials, claims, or numbers.

## Trap inventory

Each item's `tests` field says exactly what it exercises; the map:

| trap | items |
|---|---|
| Stock never stated (must stay `null`) | 01, 03, 04, 05, 08, 09, 11, 13, 14, 16, 17, 20, 22, 23, 24, 27 |
| Stock stated as vibes/urgency, not a count | 03 (`limited pieces`), 11 (`selling faster…`), 16 (`almost gone`), 22 (`restocked ✅`) |
| MRP / was-price / %-off — two+ prices, one buyable | 03, 08, 15 (`~~tildes~~` strikethrough), 20 (40% off), 26 |
| Broken / bare price formats (`sirf 699`, `1,299/- only`, `Rs.999`, `@ ₹549/-`, `1,599 flat`) | 05, 06, 09, 11, 15, 19, 22, 24, 26, 28 |
| ₹-marked numbers that are not the price (free-shipping threshold, COD limit, COD surcharge, cross-sell) | 12, 17, 21, 25 |
| No variants stated → one implicit default Variant | 06 (free size), 10, 13 (pack contents ≠ choices), 19 |
| Per-variant stock | 04 (one size low), 23 (full split, no total) |
| Colour variants (not sizes) | 09, 18 |
| Stated total across colour variants | 18 |
| Name must come from the photo | 19 |
| Stray numbers (GSM, oz, pack-of-3, wash °C, "drop 2 of 3", "2 din", tablet inches) | throughout — e.g. 01, 10, 13, 23, 24, 28 |
| Clean controls (so it's not all traps) | 02, 07, 14, 27 |

## The photos

Generated with `gpt-image-1` by `generate-images.mjs` (the committed prompts), then
downscaled to 768px JPEG. Stand-ins for a real merchant's photos, same argument as the
spike: the question ingestion asks is whether a model can read a caption against a
plausible product image. Generated images may misrender printed text (e.g. the
"BOMBAY 95" tee) — only `19-crossbody-sling-bag` *requires* the photo to identify the
product, and it contains no text.
