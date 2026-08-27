import path from 'node:path';
import process from 'node:process';
import { z } from 'zod';
import { normalizeBaseUrl } from '../../config.js';
import { approvePaymentLink } from './payerBot.js';
import { DryRunStop, runLiveEvalTask } from './runner.js';
import type { BuyerDecider } from './types.js';

/**
 * `npm run evals:probe` — the selector-tuning tool for the payer-bot.
 *
 * Razorpay's hosted Payment Link page is undocumented, unversioned, and only
 * rendered by a real link (docs/engineering-log.md, T16). The 2026-08-27 live
 * run burned a Claude decision to discover that `select UPI method` matched
 * nothing — an expensive way to learn a CSS selector. This command mints a
 * real test-mode link the cheap way (a canned decision, no model quota), opens
 * it, and dumps the page: screenshot, HTML, and an inventory of every visible
 * interactive element in every frame.
 *
 *   npm run evals:probe -- --target https://<deployment>            # inspect only
 *   npm run evals:probe -- --target https://<deployment> --pay      # drive it for real
 *   npm run evals:probe -- --target https://<deployment> --variant var_x --headless
 *
 * Inspect mode (the default) never touches a payment control, so nothing
 * moves money — but it DOES open a real mandate chain and a real Payment
 * Link, leaving an `awaiting_payment` Order on the target, exactly as
 * `--dry-run` does. `--pay` completes the purchase with `success@razorpay`
 * and is the end-to-end check that the tuned selectors actually work.
 */

const catalogSchema = z.object({
  variants: z
    .array(
      z.object({
        variantId: z.string(),
        productTitle: z.string(),
        price: z.object({ amountPaise: z.number() }),
        stock: z.number().nullable(),
      }),
    )
    .min(1),
});

interface ProbeArgs {
  readonly target: string;
  readonly variantId: string | null;
  readonly pay: boolean;
  readonly headless: boolean;
  readonly outDir: string;
}

function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv): ProbeArgs {
  let target = env['LIVE_EVAL_TARGET'] ?? env['PUBLIC_BASE_URL'] ?? '';
  let variantId: string | null = null;
  let pay = false;
  // Headed by default: the whole point is a human watching the page render.
  let headless = false;
  let outDir = 'evals';
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = (): string => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };
    if (arg === '--target') target = next();
    else if (arg === '--variant') variantId = next();
    else if (arg === '--pay') pay = true;
    else if (arg === '--headless') headless = true;
    else if (arg === '--out') outDir = next();
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (target === '') {
    throw new Error(
      'No target. Pass --target https://<deployment>, or set LIVE_EVAL_TARGET or PUBLIC_BASE_URL.',
    );
  }
  return { target, variantId, pay, headless, outDir };
}

/** The cheapest in-stock variant — the smallest real charge that proves the flow. */
async function pickVariant(
  base: string,
  wanted: string | null,
): Promise<{ variantId: string; title: string; pricePaise: number }> {
  const response = await fetch(`${base}/acp/products`);
  if (!response.ok) throw new Error(`catalog fetch failed: ${response.status}`);
  const catalog = catalogSchema.parse(await response.json());
  const candidates = catalog.variants
    .filter((v) => (wanted === null ? v.stock === null || v.stock > 0 : v.variantId === wanted))
    .sort((a, b) => a.price.amountPaise - b.price.amountPaise);
  const chosen = candidates[0];
  if (chosen === undefined) {
    throw new Error(wanted === null ? 'no purchasable variant in the catalog' : `no variant ${wanted}`);
  }
  return { variantId: chosen.variantId, title: chosen.productTitle, pricePaise: chosen.price.amountPaise };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), process.env);
  const base = normalizeBaseUrl(args.target);
  const variant = await pickVariant(base, args.variantId);
  const artifactDir = path.resolve(args.outDir, 'probe');

  console.log(`[probe] target   ${base}`);
  console.log(`[probe] variant  ${variant.variantId} — ${variant.title} (₹${variant.pricePaise / 100})`);
  console.log(`[probe] mode     ${args.pay ? 'PAY (real test-mode payment)' : 'INSPECT ONLY (no payment control touched)'}`);
  console.log(`[probe] evidence ${artifactDir}`);

  // No model quota: the "decision" is a constant. Everything downstream —
  // registration, the mandate chain, the link — is the real deployed protocol.
  const cannedDecider: BuyerDecider = async () => ({
    decision: {
      action: 'buy',
      want: `payer-bot selector probe: ${variant.title}`,
      budgetPaise: variant.pricePaise,
      items: [{ variantId: variant.variantId, quantity: 1 }],
      reasoning: 'canned decision — this run exists to render Razorpay\'s hosted page, not to shop',
    },
    transcript: ['canned decider (probe): no model was asked'],
    costUsd: null,
  });

  const result = await runLiveEvalTask(
    base,
    {
      id: 'payer-bot-probe',
      instruction: `Probe the hosted payment page with ${variant.variantId}`,
      capPaise: variant.pricePaise,
      expectation: args.pay
        ? 'A completed test-mode payment, proving the tuned selectors drive the page.'
        : 'A dumped page: screenshot, HTML and element inventory for selector tuning.',
    },
    {
      decide: cannedDecider,
      approvePayment: async (payment, { record }) => {
        const log = (line: string): void => {
          console.log(line);
          record(line.trim());
        };
        await approvePaymentLink(payment.paymentLinkUrl, {
          headless: args.headless,
          log,
          artifactDir,
          artifactPrefix: payment.orderId,
          dump: 'always',
          stopAfterInspect: !args.pay,
        });
        // Inspect mode has done its job; stop before the runner waits on a
        // webhook that is never coming.
        if (!args.pay) throw new DryRunStop();
      },
      pollIntervalMs: 3_000,
      maxPolls: 60,
      log: console.log,
    },
  );

  console.log(`[probe] outcome  ${result.outcome.kind}`);
  if (result.outcome.kind === 'error') console.log(`[probe] message  ${result.outcome.message}`);
  if (result.outcome.kind === 'paid') console.log(`[probe] audit    ${result.outcome.auditUrl}`);
  if (result.outcome.kind === 'dry_run_stopped') {
    console.log(`[probe] link     ${result.outcome.paymentLinkUrl}`);
    console.log(`[probe] audit    ${result.outcome.auditUrl}`);
  }
  console.log('[probe] transcript:');
  for (const line of result.transcript) console.log(`  ${line}`);
  if (result.outcome.kind === 'error') process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error('[probe] failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
