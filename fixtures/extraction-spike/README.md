# Extraction spike dataset (S3)

Ground truth for spike **S3 — extraction quality floor** (`PLAN.md` §7). Published here
because the spec's story 36 is that the metrics must not be the project grading its own
homework: the labels are in the repo, so anyone can re-run the spike and check the number.

```
npm run spike:extraction                     # the model configured in src/ingestion/extractionModel.ts
npm run spike:extraction -- --model=gpt-5    # any other model, no code change
npm run spike:extraction -- --out=run.json   # keep the raw model output for re-scoring
```

Requires `OPENAI_API_KEY`. This is a live billed call and deliberately **not** part of
`npm test` — the deterministic suite must not depend on a model provider being up.

## What's here

Five photo+caption pairs from the demo merchant, Kalaakar Streetwear.

| id | what it tests |
|---|---|
| `01-sabr-tee` | Baseline — name, price, stock and sizes all stated plainly. |
| `02-utility-cargo-pants` | Stock stated as vibes (`stock ready ✅`), which must extract as *unstated*. |
| `03-dhuaan-hoodie` | Two prices in one caption (`MRP 2,999/- 👉 launch price sirf ₹1,899/-`). |
| `04-corduroy-bucket-hat` | Caption never says what the product is — the name has to come from the photo. Also carries a free-shipping threshold that is not a price. |
| `05-chhaap-canvas-tote` | Three numbers, one of them a per-customer purchase limit that is not stock. |

Each item is one product, sized so the whole set runs in well under a minute. This is a
**spike** dataset for a go/no-go gate, not the demo catalog — that is T11, and it is where
per-field accuracy across a realistic catalog gets reported.

## How the labels were made

A human read each caption *with* its photo and wrote down the answer a careful merchant would
give. Labels were written **before** any model was run, and no label was changed afterwards to
match model output. Where the caption is genuinely ambiguous, the label records the reading a
buyer's money depends on:

- **price** is what a buyer actually pays — the selling price, never a struck-through MRP, and
  never a free-shipping threshold that happens to be a number.
- **stock** is `null` unless the caption states a count. `stock ready ✅` is `null`; a
  per-customer limit is not a count. This is spec story 6: an invented quantity in a live
  catalog is worse than a Product held back for Confirmation.
- **name** is the short listing title, taken from the caption when it names the product and
  from the photo when it doesn't.
- **variantLabels** are the size/colour options *offered as choices*. "one size fits all" is
  the absence of a choice, so it is `[]`, which becomes one implicit default Variant.

## The photos

Generated with OpenAI `gpt-image-1` from prompts describing an Indian streetwear label's
Instagram flat-lays, then downscaled to 768px JPEG to keep the repo small. They are stand-ins
for a real merchant's photos: this spike measures whether a vision model can read a *caption*
against a plausible product image, and generated images are honest for that question. Real
merchant photos are a T11 concern.

## The metric

**Name + price exact-match**, per item — an item counts only when *both* are right, which is
the gate `PLAN.md` §7 states and `PLAN.md` §9 kill criterion K2 turns on. Scoring lives in
`src/ingestion/spike/scoring.ts` and is unit-tested, because a scoring bug would fire or fail
to fire K2 wrongly.

- **Price** is integer-paise equality. Nothing is rounded and nothing is within-tolerance.
- **Name** is string equality after case-folding, punctuation removal and whitespace collapse
  — so `"SABR" Oversized Tee` and `Sabr Oversized Tee` are the same answer, while
  `Sabr Oversized T-Shirt` is not. Punctuation is a transcription artifact of the caption;
  word choice is a reading of it. There is no synonym list, no substring credit and no fuzzy
  distance.

Stock and variant-label accuracy are reported too, but they are not part of the S3 gate.
