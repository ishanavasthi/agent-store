/**
 * Provenance script for the demo-dataset product images (T11, PLAN §5.3).
 *
 * Generates one product shot per catalog item with OpenAI `gpt-image-1`
 * (quality "medium", 1024x1024) via plain fetch, then downscales to 768px
 * JPEG (~80 quality) with macOS `sips` so the committed set stays small —
 * the same treatment the extraction-spike images got.
 *
 * The prompts below are the exact prompts the committed images came from.
 * Captions and labels in dataset.json are hand-written and were NOT
 * produced by any model; only these photos are generated.
 *
 * Usage:
 *   OPENAI_API_KEY=... node fixtures/demo-dataset/generate-images.mjs [slug ...]
 *
 * With no args it generates every image missing from images/; pass slugs to
 * (re)generate specific ones. Requires `sips` (macOS); on other platforms the
 * 1024px PNG is left in place for you to convert by hand.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const imagesDir = join(here, 'images');

const STYLE =
  'Instagram product photo for a small Indian D2C streetwear brand. ' +
  'Natural daylight, slightly moody, shot on a phone but well composed. ' +
  'No people, no faces, no watermark, no overlaid text or graphics.';

/** slug -> subject prompt (STYLE is appended to each). */
const PROMPTS = {
  '01-raat-oversized-tee':
    'Flat lay on a dark concrete floor: a jet black oversized heavyweight t-shirt, 240 GSM french terry, boxy silhouette, subtle tonal puff print of a crescent moon on the chest.',
  '02-bombay-95-graphic-tee':
    'A white regular-fit cotton t-shirt on a wooden hanger against a sunlit textured wall, large retro screen print artwork of a coastal city skyline with the text "BOMBAY 95" in varsity lettering.',
  '03-aandhi-windcheater':
    'A lightweight slate-grey nylon windcheater jacket with a packable hood and reflective zip, laid on wet-look dark concrete, water droplets beading on the fabric.',
  '04-galli-cargo-pants':
    'Flat lay of olive-green ripstop cargo pants with eight pockets and adjustable ankle cuffs, neatly arranged on a grey concrete floor with a measuring tape beside them.',
  '05-safed-classic-tee':
    'A plain white classic-fit t-shirt, 220 GSM cotton, no print at all, folded in a neat stack on a white linen sheet, minimalist bright composition.',
  '06-nazar-snapback-cap':
    'A black twill snapback cap with a flat brim and a small embroidered blue evil-eye symbol on the front panel, resting on a rough stone ledge, shallow depth of field.',
  '07-udaan-hoodie':
    'A heavyweight off-white hoodie with brushed fleece visible at the rolled cuff and a small embroidered bird logo on the chest, hanging on a metal rack against an exposed brick wall.',
  '08-kohra-acid-wash-hoodie':
    'A grey acid-wash hoodie with a heavily mottled bleach pattern, drop shoulders, laid flat on black fabric so the wash texture is the hero.',
  '09-patang-crop-tee':
    'Three folded boxy cropped t-shirts stacked together — lilac, mint green and white — on a pastel background, soft daylight, kite-shaped tag beside them.',
  '10-thela-tote-bag':
    'A natural ecru heavy canvas tote bag with a zip top, standing upright filled with a baguette and greens, on a market table, warm evening light.',
  '11-akkad-joggers':
    'Charcoal french terry tapered joggers with zip pockets, flat lay on a gym rubber floor next to a skipping rope.',
  '12-bijli-varsity-jacket':
    'A navy wool-blend varsity jacket with cream PU leather sleeves and a chenille lightning-bolt patch, on a mannequin torso against a dark studio background.',
  '13-chai-biscuit-socks':
    'Three pairs of ribbed crew socks in tan brown, biscuit beige and off-white, rolled and arranged next to a cutting chai glass and biscuits on a steel tray.',
  '14-jugaad-utility-vest':
    'A black utility vest with six pockets, mesh lining and metal D-rings, laid flat on plywood with a carabiner clipped to one ring.',
  '15-monsoon-check-shacket':
    'An oversized brushed flannel shacket in a brown and rust check pattern with a button front, draped over a wooden chair by a rain-streaked window.',
  '16-sadak-slides':
    'A pair of black slides with thick padded straps and chunky soles on a sunlit concrete step, harsh shadow lines.',
  '17-hawa-low-top-sneakers':
    'A pair of clean white vegan leather low-top sneakers with gum rubber soles, one propped on a concrete block, side profile, minimalist studio look.',
  '18-dhundh-beanie':
    'Two ribbed knit beanies with fold cuffs, one black and one grey, stacked on a foggy-morning windowsill.',
  '19-crossbody-sling-bag':
    'A black water-resistant crossbody sling bag with three zip compartments and an adjustable webbing strap, worn look across a denim jacket on a mannequin torso, no face visible.',
  '20-antenna-graphic-hoodie':
    'The back of a washed black heavyweight hoodie laid flat, large white line-art back print of a radio transmission tower with signal waves.',
  '21-khoya-denim-jacket':
    'An oversized washed indigo denim jacket with antique brass buttons on a wooden hanger against a whitewashed wall, faded patina visible.',
  '22-firangi-track-pants':
    'Black poly-cotton track pants with a white contrast side stripe and ankle zips, flat lay diagonal composition on an asphalt surface.',
  '23-machli-mesh-shorts':
    'Teal double-layer mesh athletic shorts with an inner liner visible at the hem, flat lay on light sand with a faint fish-scale shadow pattern.',
  '24-jalebi-tie-dye-tee':
    'A swirling orange and saffron tie-dye t-shirt with a spiral pattern reminiscent of a jalebi sweet, drying on a line in warm Jaipur light.',
  '25-raakh-cargo-shorts':
    'Washed ash-grey cotton twill knee-length cargo shorts with six pockets, flat lay on dark slate tiles.',
  '26-parinda-puffer-vest':
    'A lightweight black quilted puffer vest with a high neck and zip pockets, on a mannequin torso, dramatic side lighting, a single black feather resting on the shoulder.',
  '27-taxi-camp-collar-shirt':
    'A viscose camp collar shirt with an all-over retro print of black-and-yellow vintage taxis, on a hanger against a mustard yellow wall.',
  '28-chandni-glow-tee':
    'A washed black oversized t-shirt with a pale green glow-in-the-dark full moon print on the chest, laid flat in low light so the print faintly glows.',
};

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error('OPENAI_API_KEY is not set');
  process.exit(1);
}

const requested = process.argv.slice(2);
for (const slug of requested) {
  if (!(slug in PROMPTS)) {
    console.error(`unknown slug: ${slug}`);
    process.exit(1);
  }
}
const slugs = (requested.length > 0 ? requested : Object.keys(PROMPTS)).filter(
  (slug) => requested.length > 0 || !existsSync(join(imagesDir, `${slug}.jpg`)),
);

mkdirSync(imagesDir, { recursive: true });

async function generateOne(slug) {
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-image-1',
      prompt: `${PROMPTS[slug]} ${STYLE}`,
      size: '1024x1024',
      quality: 'medium',
    }),
  });
  if (!res.ok) {
    throw new Error(`${slug}: HTTP ${res.status} — ${(await res.text()).slice(0, 300)}`);
  }
  const body = await res.json();
  const b64 = body?.data?.[0]?.b64_json;
  if (!b64) throw new Error(`${slug}: response had no b64_json`);

  const pngPath = join(imagesDir, `${slug}.png`);
  const jpgPath = join(imagesDir, `${slug}.jpg`);
  writeFileSync(pngPath, Buffer.from(b64, 'base64'));
  try {
    execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '80', '-Z', '768', pngPath, '--out', jpgPath], {
      stdio: 'ignore',
    });
    unlinkSync(pngPath);
  } catch {
    console.warn(`${slug}: sips unavailable — left ${pngPath} unconverted`);
  }
  console.log(`done ${slug}`);
}

const queue = [...slugs];
const failures = [];
async function worker() {
  for (let slug = queue.shift(); slug !== undefined; slug = queue.shift()) {
    try {
      await generateOne(slug);
    } catch (err) {
      failures.push(slug);
      console.error(String(err));
    }
  }
}

console.log(`generating ${slugs.length} image(s)…`);
await Promise.all(Array.from({ length: 4 }, worker));
if (failures.length > 0) {
  console.error(`FAILED: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('all done');
