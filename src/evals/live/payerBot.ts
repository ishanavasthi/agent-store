import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * The Playwright payer-bot: the "human consent tap" for unattended live runs.
 *
 * Given a Razorpay-hosted Payment Link URL it drives the hosted checkout —
 * select UPI, enter the test VPA `success@razorpay`, submit — so a live eval
 * run can complete on real test rails without a human at the keyboard
 * (PLAN §6). Test mode then settles the payment server-side at Razorpay and
 * the webhooks flip our Order to paid; the runner's get_order_status polling
 * is the authoritative success signal, NOT anything this bot observes on the
 * page.
 *
 * PLAN §7 lists "Playwright mechanics against the hosted payment-link page"
 * as a detail-level unknown, and it still partly is: the hosted page is
 * Razorpay's, unversioned, and changes without notice. So every step here
 * works through a *list of named candidate locators* tried in order, and the
 * bot records which candidate matched (or that the step was skipped) in
 * `steps`, which the runner threads into the run's transcript. When a
 * required step finds nothing, the bot dumps the page — screenshot, HTML,
 * and an inventory of every visible interactive element in every frame — so
 * the next attempt tunes selectors from evidence instead of guesswork.
 * See docs/engineering-log.md (T16 entries) for the research trail.
 *
 * Playwright is a devDependency, imported lazily: CI and the shipped server
 * never load it, and `dryRun` stops before any browser exists at all.
 */

export interface PayerBotOptions {
  /** Stop before launching a browser — CI safety. Validates the URL only. */
  readonly dryRun?: boolean;
  /** Headed helps a watching human; headless is the unattended default. */
  readonly headless?: boolean;
  /** Per-step timeout. The hosted page can be slow on cold Razorpay CDN hits. */
  readonly stepTimeoutMs?: number;
  /** The VPA to pay with. `failure@razorpay` drives the decline rehearsal. */
  readonly vpa?: string;
  /**
   * Contact details for checkout's first screen, when it asks. The default is
   * a well-formed Indian mobile number: checkout rejects `9999999999` with
   * "Please enter a valid mobile number" and simply never advances — which is
   * exactly how the 2026-08-27 live run died three steps later.
   */
  readonly contactPhone?: string;
  readonly contactEmail?: string;
  readonly log?: (line: string) => void;
  /**
   * Where page evidence lands. Without it a failure is just a message —
   * which is exactly how the 2026-08-27 run lost its selector evidence.
   */
  readonly artifactDir?: string;
  /** Filename prefix; the caller passes the Order id so evidence ties to the audit chain. */
  readonly artifactPrefix?: string;
  /** `always` also dumps the freshly-loaded page (what `evals:probe` wants). */
  readonly dump?: 'on-failure' | 'always';
  /**
   * Inspect only: load the page, dump it, and return without touching a
   * payment control. Nothing moves money — this is the selector-tuning mode.
   */
  readonly stopAfterInspect?: boolean;
}

export interface PayerBotReport {
  readonly mode: 'dry-run' | 'live' | 'inspected';
  readonly url: string;
  /** What happened, step by step — the tuning evidence for selector drift. */
  readonly steps: readonly string[];
  /** Paths of any page evidence written (screenshot, HTML, element inventory). */
  readonly artifacts: readonly string[];
}

export class PayerBotError extends Error {
  readonly steps: readonly string[];
  readonly artifacts: readonly string[];
  constructor(message: string, steps: readonly string[], artifacts: readonly string[] = []) {
    super(message);
    this.name = 'PayerBotError';
    this.steps = steps;
    this.artifacts = artifacts;
  }
}

export const TEST_UPI_SUCCESS_VPA = 'success@razorpay';
export const TEST_UPI_FAILURE_VPA = 'failure@razorpay';

/**
 * Checkout's contact screen refuses to advance on a number it recognises as
 * fake, and says only "Please enter a valid mobile number": `9999999999` and
 * `9876543210` are both rejected, `7042318965` is accepted (measured against
 * the live hosted page, 2026-08-28 — see docs/engineering-log.md). Nothing is
 * ever sent to it: test mode notifies nobody, and this exists only to get
 * past a screen that will not let a payer through without something here.
 */
export const TEST_CONTACT_PHONE = '7042318965';

/**
 * A phone-shaped browser. Not cosmetic: Razorpay's desktop checkout offers UPI
 * only as a QR code — unscannable by a bot — while the mobile layout lists the
 * UPI intent apps, which test mode settles instantly. Spelled out rather than
 * taken from Playwright's `devices` registry so a Playwright upgrade cannot
 * silently change which page the bot is driving.
 */
const MOBILE_DEVICE = {
  viewport: { width: 412, height: 915 },
  userAgent:
    'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36',
  deviceScaleFactor: 2.625,
  isMobile: true,
  hasTouch: true,
} as const;

/** One named way to find a control. The name is what lands in the step log. */
type Candidate = readonly [name: string, find: (frame: import('playwright').Frame) => import('playwright').Locator];

/**
 * Selectors worth listing in an element inventory: everything a checkout
 * flow could plausibly want clicked or typed into. Kept as plain CSS so the
 * inventory needs no DOM lib types (tsconfig ships `lib: ES2023` only).
 */
const INVENTORY_SELECTORS = [
  'button',
  '[role="button"]',
  'input',
  'select',
  'a[href]',
  '[data-value]',
  '[class*="method" i]',
] as const;

const ATTRS = ['id', 'name', 'type', 'placeholder', 'data-value', 'aria-label', 'class'] as const;

/**
 * Frame URLs, minus the query string. Razorpay's checkout frame carries a
 * `session_token` and a `keyless_header` in its URL; those would otherwise
 * land in the run transcript, which is committed to a public repo. The
 * origin + path is all the tuning evidence needs.
 */
const frameLabel = (frame: import('playwright').Frame): string => {
  const url = frame.url();
  if (url === '') return '(about:blank)';
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return url;
    return `${parsed.origin}${parsed.pathname}${parsed.search === '' ? '' : '?…'}`;
  } catch {
    return '(unparseable)';
  }
};

/**
 * Everything visible and interactive, frame by frame — the artifact that
 * actually answers "what should the selector have been?".
 */
async function inventory(page: import('playwright').Page): Promise<string> {
  const lines: string[] = [];
  for (const frame of page.frames()) {
    lines.push(`=== frame ${frame === page.mainFrame() ? '(main)' : ''} url=${frameLabel(frame)}`);
    for (const selector of INVENTORY_SELECTORS) {
      let elements: import('playwright').Locator[];
      try {
        elements = await frame.locator(selector).all();
      } catch {
        continue; // Frame detached mid-walk; the rest of the dump still stands.
      }
      for (const element of elements.slice(0, 60)) {
        try {
          if (!(await element.isVisible({ timeout: 250 }))) continue;
          const attrs: string[] = [];
          for (const attr of ATTRS) {
            const value = await element.getAttribute(attr);
            if (value !== null && value !== '') attrs.push(`${attr}=${JSON.stringify(value)}`);
          }
          const text = ((await element.textContent()) ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
          lines.push(`  ${selector} ${attrs.join(' ')}${text === '' ? '' : ` text=${JSON.stringify(text)}`}`);
        } catch {
          // Element went away while being described — skip it, keep dumping.
        }
      }
    }
  }
  return lines.join('\n');
}

/**
 * Write screenshot + HTML + element inventory. Best-effort by construction:
 * evidence gathering must never mask the failure it is evidence for.
 */
async function dumpPage(
  page: import('playwright').Page,
  dir: string,
  prefix: string,
  record: (line: string) => void,
): Promise<string[]> {
  const written: string[] = [];
  try {
    await mkdir(dir, { recursive: true });
    const png = path.join(dir, `${prefix}.png`);
    await page.screenshot({ path: png, fullPage: true });
    written.push(png);

    const html = path.join(dir, `${prefix}.html`);
    await writeFile(html, await page.content(), 'utf8');
    written.push(html);

    const txt = path.join(dir, `${prefix}.elements.txt`);
    await writeFile(txt, `${await inventory(page)}\n`, 'utf8');
    written.push(txt);

    record(`page evidence written: ${written.map((p) => path.basename(p)).join(', ')}`);
  } catch (error) {
    record(`page evidence FAILED: ${error instanceof Error ? error.message : String(error)}`);
  }
  return written;
}

/** Approve (or, with failure@razorpay, decline) a hosted Payment Link. */
export async function approvePaymentLink(
  url: string,
  options: PayerBotOptions = {},
): Promise<PayerBotReport> {
  const steps: string[] = [];
  const artifacts: string[] = [];
  const log = options.log ?? (() => {});
  const record = (line: string): void => {
    steps.push(line);
    log(`  payer-bot: ${line}`);
  };

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new PayerBotError(`not a URL: ${url}`, steps);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new PayerBotError(`refusing non-http(s) payment link: ${url}`, steps);
  }
  record(`payment link accepted: ${parsed.href}`);

  if (options.dryRun === true) {
    record('dry run: stopping before any browser launch');
    return { mode: 'dry-run', url: parsed.href, steps, artifacts };
  }

  const { chromium } = await import('playwright');
  const stepTimeout = options.stepTimeoutMs ?? 15_000;
  const vpa = options.vpa ?? TEST_UPI_SUCCESS_VPA;
  const artifactDir = options.artifactDir;
  const prefix = options.artifactPrefix ?? 'payer-bot';
  const browser = await chromium.launch({ headless: options.headless ?? true });
  try {
    // Mobile, deliberately: desktop checkout's UPI screen is a QR and nothing
    // else — no intent tiles, no UPI-ID field — so a desktop browser can never
    // finish a UPI payment unattended. The mobile layout lists the intent apps
    // (measured 2026-08-28; see docs/engineering-log.md).
    const context = await browser.newContext(MOBILE_DEVICE);
    const page = await context.newPage();
    await page.goto(parsed.href, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    // The hosted page mounts checkout asynchronously; a fixed settle beat
    // costs a second and keeps the first dump from catching an empty shell.
    await page.waitForTimeout(3_000);
    record(`hosted page loaded: ${page.url()}`);
    record(`frames: ${page.frames().map(frameLabel).join(' | ')}`);

    if (artifactDir !== undefined && options.dump === 'always') {
      artifacts.push(...(await dumpPage(page, artifactDir, `${prefix}-loaded`, record)));
    }

    if (options.stopAfterInspect === true) {
      record('inspect only: returning without touching any payment control');
      return { mode: 'inspected', url: parsed.href, steps, artifacts };
    }

    /** Try named candidate locators across surfaces until one is actionable. */
    const tryStep = async (
      what: string,
      candidates: readonly Candidate[],
      action: (locator: import('playwright').Locator) => Promise<void>,
      { required }: { required: boolean },
    ): Promise<boolean> => {
      const deadline = Date.now() + stepTimeout;
      while (Date.now() < deadline) {
        // Recomputed every pass: checkout can mount its iframe late.
        const frames = [
          ...page.frames().filter((f) => f !== page.mainFrame() && /razorpay|checkout/i.test(f.url())),
          page.mainFrame(),
        ];
        for (const frame of frames) {
          for (const [name, find] of candidates) {
            try {
              const locator = find(frame).first();
              if (await locator.isVisible({ timeout: 250 })) {
                await action(locator);
                const where = frame === page.mainFrame() ? 'main' : 'checkout';
                record(`${what}: done via [${name}] in ${where} frame`);
                if (artifactDir !== undefined && options.dump === 'always') {
                  // Probe mode: a dump per step is how the *next* screen's
                  // selectors get discovered without another live run.
                  await page.waitForTimeout(2_000);
                  artifacts.push(
                    ...(await dumpPage(page, artifactDir, `${prefix}-after-${slug(what)}`, record)),
                  );
                }
                return true;
              }
            } catch {
              // This candidate is not it (detached, hidden, wrong variant) —
              // move on; the loop retries until the step deadline.
            }
          }
        }
        await page.waitForTimeout(500);
      }
      if (required) {
        record(`${what}: NO candidate matched — tried [${candidates.map(([n]) => n).join(', ')}]`);
        if (artifactDir !== undefined) {
          artifacts.push(...(await dumpPage(page, artifactDir, `${prefix}-failed-${slug(what)}`, record)));
        }
        throw new PayerBotError(
          `${what}: no candidate locator matched within ${stepTimeout}ms`,
          steps,
          artifacts,
        );
      }
      record(`${what}: skipped (not present on this page variant)`);
      return false;
    };

    // 1. The mobile link page does not auto-open checkout: it shows the
    //    invoice with a "Proceed to Pay" button. Desktop opens it for you,
    //    hence optional.
    await tryStep(
      'open checkout',
      [
        ['#mob-payment-btn', (f) => f.locator('#mob-payment-btn')],
        ['role=button proceed to pay', (f) => f.getByRole('button', { name: /proceed to pay/i })],
      ],
      (l) => l.click(),
      { required: false },
    );

    // 2. Contact screen, when the link asks for it (links created without a
    //    `customer` block — ours, per the S1 finding — always do).
    await tryStep(
      'fill contact phone',
      [
        ['input[type=tel]', (f) => f.locator('input[type="tel"]')],
        ['#contact', (f) => f.locator('#contact')],
        ['input[name=contact]', (f) => f.locator('input[name="contact"]')],
      ],
      // Typed, not filled: checkout's contact validator listens to keystrokes,
      // so a `fill()` leaves the value visible but the field still "invalid"
      // ("Please enter a valid mobile number") and Continue never advances.
      async (l) => {
        await l.click();
        await l.fill('');
        await l.pressSequentially(options.contactPhone ?? TEST_CONTACT_PHONE, { delay: 60 });
      },
      { required: false },
    );
    await tryStep(
      'fill contact email',
      [
        ['input[type=email]', (f) => f.locator('input[type="email"]')],
        ['#email', (f) => f.locator('#email')],
      ],
      (l) => l.fill(options.contactEmail ?? 'payer-bot@example.test'),
      { required: false },
    );
    await tryStep(
      'continue past contact screen',
      [
        ['[data-testid=bottom-cta-button]', (f) => f.locator('[data-testid="bottom-cta-button"]')],
        ['role=button proceed|continue|next', (f) => f.getByRole('button', { name: /proceed|continue|next/i })],
        ['button[type=submit]', (f) => f.locator('button[type="submit"]')],
      ],
      (l) => l.click(),
      { required: true },
    );

    // 3. Pick UPI. `[data-value="upi"]` is the intent tile ("UPI - Google
    //    Pay"): in test mode selecting it settles the payment server-side
    //    within seconds and checkout closes itself — which is why nothing
    //    below is required. The generic text matchers stay as fallbacks for
    //    the day Razorpay reshuffles the list.
    await tryStep(
      'select UPI method',
      [
        ['[data-value=upi]', (f) => f.locator('[data-value="upi"]')],
        ['role=button ^upi', (f) => f.getByRole('button', { name: /^upi\b/i })],
        ['text ^UPI$', (f) => f.getByText(/^UPI( \/ QR)?$/i)],
        ['text UPI', (f) => f.getByText(/UPI/i)],
      ],
      (l) => l.click(),
      { required: true },
    );

    // 4. If a UPI-ID field is on screen (the "Apps & UPI ID" → "Others"
    //    route), use it — that is the only way to drive `failure@razorpay`.
    //    Optional: the intent tile above has usually already settled the
    //    payment, and checkout is gone by now.
    const typedVpa = await tryStep(
      `enter VPA ${vpa}`,
      [
        ['input[name=vpa]', (f) => f.locator('input[name="vpa"]')],
        ['#vpa', (f) => f.locator('#vpa')],
        ['placeholder upi id', (f) => f.getByPlaceholder(/upi id|vpa|@/i)],
      ],
      async (l) => {
        await l.click();
        await l.pressSequentially(vpa, { delay: 40 });
      },
      { required: false },
    );
    if (typedVpa) {
      await tryStep(
        'submit payment',
        [
          ['role=button verify and pay|pay', (f) => f.getByRole('button', { name: /verify and pay|pay now|pay\b/i })],
          ['[data-testid=bottom-cta-button]', (f) => f.locator('[data-testid="bottom-cta-button"]')],
        ],
        (l) => l.click(),
        { required: false },
      );
    }

    // 5. Best-effort confirmation. Test mode settles server-side within
    //    seconds; the page may show a success screen, redirect to the
    //    callback, or simply close. The runner's order-status polling
    //    decides — this only annotates the report.
    const confirmed = await tryStep(
      'observe on-page confirmation',
      [
        ['text payment successful', (f) => f.getByText(/payment successful|paid successfully|success/i)],
        ['text payment failed', (f) => f.getByText(/payment failed|failure/i)],
      ],
      async () => {},
      { required: false },
    );
    if (!confirmed) {
      record('no on-page confirmation observed; relying on order-status polling');
    }

    return { mode: 'live', url: parsed.href, steps, artifacts };
  } finally {
    await browser.close().catch(() => {});
  }
}

const slug = (what: string): string => what.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
