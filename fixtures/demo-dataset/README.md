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
- `runs/<model>.json` — committed accuracy runs, written by `npm run ingest:accuracy`
  (T12): per-field scores vs these labels, every raw model response, the threshold sweep
  `AUTO_PUBLISH_THRESHOLD` is tuned on, and what the lifecycle gate published vs held.
  Same argument as the spike's `runs/`: every accuracy number the repo claims is read off
  a committed record, and `src/ingestion/demoRun.test.ts` pins it in CI.

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
