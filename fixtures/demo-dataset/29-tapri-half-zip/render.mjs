/**
 * Renders screenshot.html to screenshot.png with the Chromium that Playwright
 * already installs for this repo. Not part of `npm test` — the PNG is
 * committed, and this script is how it is regenerated after a caption edit.
 *
 *   node fixtures/demo-dataset/29-tapri-half-zip/render.mjs
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 420, height: 200 }, deviceScaleFactor: 2 });
await page.goto(`file://${path.join(here, 'screenshot.html')}`);
await page.screenshot({ path: path.join(here, 'screenshot.png'), fullPage: true });
await browser.close();
console.log('wrote screenshot.png');
