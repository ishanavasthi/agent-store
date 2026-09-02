# The 29th caption — TAPRI half-zip (video prop, not dataset)

The caption the merchant submits **on camera** in the video's opening take (plan
`docs/superpowers/plans/2026-09-03-pre-release.md` D14). It lives here, beside the demo
dataset, and deliberately **not in `dataset.json`**: it has no hand-written ground-truth
label, it is not scored by `npm run ingest:accuracy`, and it must never move the committed
accuracy numbers. The dataset stays 28 items.

| File | What it is |
| --- | --- |
| `caption.txt` | The caption, verbatim. This is what `submit_catalog_item` receives. |
| `screenshot.html` | The source of the mock post — the caption is live text, so it stays greppable and editable. |
| `screenshot.png` | Rendered from that HTML. This is the file dropped into the chat in Take A. |
| `render.mjs` | `node fixtures/demo-dataset/29-tapri-half-zip/render.mjs` re-renders the PNG after a caption edit. Uses the Chromium Playwright already installs; not part of `npm test`. |

## Why it is written the way it is

It has to make the confidence gate **hold the Product on camera**, so the caption:

- **states one unambiguous price** (`₹1,499/-`), in the dataset's messy register, with no
  MRP, no discount and no second number to pick between — the extraction should get this
  right without drama, because the price is not what the demo is about;
- **states no stock, in any form** — not a count, not a "20 pieces left", and not a stray
  number that could be misread as one (no "drop 3 of 3", no pack sizes, no GSM). The
  urgency is carried by words only. `stock` is therefore `null`, the Product is Held with
  `holds: ["stock"]`, and the beat plays: Claude asks, the merchant answers "S 4, M 6, L 5",
  `confirm_product` publishes it;
- **offers three sizes** (`S M L`), so the confirmation answer is a short, natural sentence
  rather than a table.

It is a new product for the same fictional brand (Kalaakar Streetwear) and repeats none of
the 28 dataset products, so nothing in the catalog collides with it during the take.

The screenshot is a **mock**, not a real Instagram capture: no wordmark, no borrowed chrome,
no real handle, and a placeholder in the photo area. Take A only needs the caption to be
legible enough to transcribe.

## Wording is the owner's call

D14 gives the owner the veto on this caption's wording. Editing it means editing
`caption.txt` **and** the `.caption` block in `screenshot.html` (they are the same text in
two places by design — the PNG has to show exactly what gets submitted), then re-running
`render.mjs`.
