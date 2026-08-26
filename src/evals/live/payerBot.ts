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
 * works through a *list of candidate locators* tried in order, and the bot
 * records what it did (and which candidate matched) in `steps` so the first
 * human-triggered run can tune the lists from evidence instead of guesswork.
 * What is known (docs + S1 spike): the link opens Razorpay standard checkout
 * (usually inside an `iframe.razorpay-checkout-frame`), may first ask for a
 * contact number/email, lists payment methods including UPI, and in test mode
 * accepts `success@razorpay` / `failure@razorpay` as instant-outcome VPAs.
 * See docs/engineering-log.md (T16 entry) for the research trail.
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
  /** Contact details for checkout's first screen, when it asks. */
  readonly contactPhone?: string;
  readonly contactEmail?: string;
  readonly log?: (line: string) => void;
}

export interface PayerBotReport {
  readonly mode: 'dry-run' | 'live';
  readonly url: string;
  /** What happened, step by step — the tuning evidence for selector drift. */
  readonly steps: readonly string[];
}

export class PayerBotError extends Error {
  readonly steps: readonly string[];
  constructor(message: string, steps: readonly string[]) {
    super(message);
    this.name = 'PayerBotError';
    this.steps = steps;
  }
}

export const TEST_UPI_SUCCESS_VPA = 'success@razorpay';
export const TEST_UPI_FAILURE_VPA = 'failure@razorpay';

/** Approve (or, with failure@razorpay, decline) a hosted Payment Link. */
export async function approvePaymentLink(
  url: string,
  options: PayerBotOptions = {},
): Promise<PayerBotReport> {
  const steps: string[] = [];
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
    return { mode: 'dry-run', url: parsed.href, steps };
  }

  const { chromium } = await import('playwright');
  const stepTimeout = options.stepTimeoutMs ?? 15_000;
  const vpa = options.vpa ?? TEST_UPI_SUCCESS_VPA;
  const browser = await chromium.launch({ headless: options.headless ?? true });
  try {
    const page = await browser.newPage();
    await page.goto(parsed.href, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    record('hosted page loaded');

    // Standard checkout usually mounts in an iframe on the hosted link page;
    // some variants render inline. Search both, iframe first.
    const surfaces = () => {
      const frames = page
        .frames()
        .filter((f) => f !== page.mainFrame() && /razorpay|checkout/i.test(f.url()));
      return [...frames, page.mainFrame()];
    };

    /** Try candidate locators across surfaces until one is actionable. */
    const tryStep = async (
      what: string,
      candidates: ReadonlyArray<(f: import('playwright').Frame) => import('playwright').Locator>,
      action: (locator: import('playwright').Locator) => Promise<void>,
      { required }: { required: boolean },
    ): Promise<boolean> => {
      const deadline = Date.now() + stepTimeout;
      while (Date.now() < deadline) {
        for (const frame of surfaces()) {
          for (const candidate of candidates) {
            try {
              const locator = candidate(frame).first();
              if (await locator.isVisible({ timeout: 250 })) {
                await action(locator);
                record(`${what}: done (frame ${frame === page.mainFrame() ? 'main' : 'checkout'})`);
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
        throw new PayerBotError(`${what}: no candidate locator matched within ${stepTimeout}ms`, steps);
      }
      record(`${what}: skipped (not present on this page variant)`);
      return false;
    };

    // 1. Contact screen, when the link asks for it (links created without a
    //    `customer` block — ours, per the S1 finding — often do).
    await tryStep(
      'fill contact phone',
      [
        (f) => f.locator('input[type="tel"]'),
        (f) => f.locator('#contact'),
        (f) => f.locator('input[name="contact"]'),
      ],
      (l) => l.fill(options.contactPhone ?? '9999999999'),
      { required: false },
    );
    await tryStep(
      'fill contact email',
      [(f) => f.locator('input[type="email"]'), (f) => f.locator('#email')],
      (l) => l.fill(options.contactEmail ?? 'payer-bot@example.test'),
      { required: false },
    );
    await tryStep(
      'continue past contact screen',
      [
        (f) => f.getByRole('button', { name: /proceed|continue|next/i }),
        (f) => f.locator('button[type="submit"]'),
      ],
      (l) => l.click(),
      { required: false },
    );

    // 2. Pick UPI among the payment methods.
    await tryStep(
      'select UPI method',
      [
        (f) => f.getByRole('button', { name: /^upi\b/i }),
        (f) => f.getByText(/^UPI( \/ QR)?$/i),
        (f) => f.locator('[data-value="upi"], [id*="upi" i][role="button"]'),
        (f) => f.getByText(/UPI/i),
      ],
      (l) => l.click(),
      { required: true },
    );

    // 3. UPI collect: enter the test VPA. This is the one step that must
    //    succeed for the run to mean anything.
    await tryStep(
      `enter VPA ${vpa}`,
      [
        (f) => f.locator('input[name="vpa"]'),
        (f) => f.locator('#vpa'),
        (f) => f.getByPlaceholder(/upi|vpa|@/i),
        (f) => f.locator('input[type="text"]'),
      ],
      (l) => l.fill(vpa),
      { required: true },
    );

    // 4. Submit.
    await tryStep(
      'submit payment',
      [
        (f) => f.getByRole('button', { name: /verify and pay|pay now|pay\b/i }),
        (f) => f.locator('button[type="submit"]'),
      ],
      (l) => l.click(),
      { required: true },
    );

    // 5. Best-effort confirmation. Test-mode VPAs settle server-side within
    //    seconds; the page may show a success screen, redirect to the
    //    callback, or neither. The runner's order-status polling decides —
    //    this only annotates the report.
    const confirmed = await tryStep(
      'observe on-page confirmation',
      [
        (f) => f.getByText(/payment successful|paid successfully|success/i),
        (f) => f.getByText(/payment failed|failure/i),
      ],
      async () => {},
      { required: false },
    );
    if (!confirmed) {
      record('no on-page confirmation observed; relying on order-status polling');
    }

    return { mode: 'live', url: parsed.href, steps };
  } finally {
    await browser.close().catch(() => {});
  }
}
