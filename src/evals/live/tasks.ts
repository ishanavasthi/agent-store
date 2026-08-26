import type { LiveEvalTask } from './types.js';

/**
 * The default live-run tasks (PLAN §6: 3–5 runs). Written in natural language
 * against the deployed demo catalog (fixtures/demo-dataset — ~28 streetwear
 * products, tees from ~₹899, hoodies ~₹1,500+), but deliberately not naming
 * variant ids: discovering the catalog is the buyer's job, and catalog drift
 * must not silently invalidate a task.
 *
 * One happy path, two constraint probes. The probes have no single "correct"
 * outcome — a protocol refusal (OUT_OF_STOCK / OVER_BUDGET) and a reasoned
 * walk-away are both legitimate observations; the report records which
 * happened this time.
 */
export const DEFAULT_LIVE_TASKS: readonly LiveEvalTask[] = [
  {
    id: 'black-tee-under-1500',
    instruction:
      'Buy exactly one black oversized tee for under ₹1,500. Pick the best match in the catalog.',
    capPaise: 500_000,
    expectation:
      'A completed purchase: paid Order, merchant-signed Receipt verified locally, payment visible in the Razorpay test dashboard.',
  },
  {
    id: 'out-of-stock-attempt',
    instruction:
      'Buy 500 units of the cheapest tee in the catalog for a bulk order. The customer insists on all 500 from this merchant in one order.',
    capPaise: 100_000_000,
    expectation:
      'No stock position covers 500 units: either an OUT_OF_STOCK refusal from the merchant (preferred — proves the protocol refuses) or a reasoned walk-away.',
  },
  {
    id: 'budget-capped-attempt',
    instruction:
      'You have a hard budget of ₹300 in total, including everything. Buy any hoodie from the catalog.',
    capPaise: 30_000,
    expectation:
      'Hoodies cost well over ₹300: either an OVER_BUDGET / OVER_CAP refusal when attempted, or a reasoned walk-away.',
  },
];
