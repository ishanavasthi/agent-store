import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StorefrontDeps } from '../../deps.js';
import { StubGateway, type SyntheticWebhook } from '../../gateway/stubGateway.js';
import { RAZORPAY_SIGNATURE_HEADER } from '../../gateway/razorpayWebhook.js';
import { createApp } from '../../http/app.js';
import { createTestDatabase, type TestDatabaseHandle } from '../../testSupport/pgliteDatabase.js';
import { MERCHANT_ID, seedCatalog } from '../../testSupport/seedCatalog.js';
import { DryRunStop, runLiveEvalSuite, runLiveEvalTask } from './runner.js';
import { renderLiveReport } from './report.js';
import type { BuyerDecider, LiveEvalTask } from './types.js';

/**
 * T16 harness self-test: the live-eval RUNNER, end to end, against the real
 * Express app over real HTTP — Streamable HTTP MCP transport in, webhook
 * route (raw-body signature verification included) back in — with the two
 * non-deterministic seams swapped for deterministic stand-ins:
 *
 *   - decider: canned (the Agent SDK would make CI slow and flaky — the seam
 *     exists precisely so the orchestration is provable without it);
 *   - approver: the stub gateway completes the payment and the test POSTs the
 *     synthetic webhooks to the app exactly as Razorpay would.
 *
 * What the real runs add on top — Claude deciding, Playwright paying — is
 * human-triggered (docs/live-evals.md); nothing here spends model quota or
 * touches rails.
 */

const TEE = 'var_test_tee_default'; // ₹1,299.00, stock 3 (seedCatalog)

const task = (overrides: Partial<LiveEvalTask> = {}): LiveEvalTask => ({
  id: 'test-task',
  instruction: 'buy a tee',
  capPaise: 500_000,
  expectation: 'paid',
  ...overrides,
});

const cannedDecider =
  (items: ReadonlyArray<{ variantId: string; quantity: number }>, budgetPaise: number): BuyerDecider =>
  async () => ({
    decision: {
      action: 'buy',
      want: 'a tee, decided cannedly',
      budgetPaise,
      items,
      reasoning: 'canned decision for the harness self-test',
    },
    transcript: ['canned decider ran'],
    costUsd: null,
  });

describe('the live-eval runner against the local app + gateway stub', () => {
  let handle: TestDatabaseHandle;
  let gateway: StubGateway;
  let deps: StorefrontDeps;
  let server: Server;
  let baseUrl: string;

  /** Deliver a synthetic webhook the way Razorpay does: HTTP POST, signed raw body. */
  async function deliver(hook: SyntheticWebhook): Promise<void> {
    const response = await fetch(`${baseUrl}/webhooks/razorpay`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [RAZORPAY_SIGNATURE_HEADER]: hook.signature,
      },
      body: hook.rawBody,
    });
    expect(response.status).toBe(200);
  }

  /** The CI consent step: settle on the stub, deliver both webhooks over HTTP. */
  const stubApprover = async (payment: { gatewayPaymentLinkId: string }): Promise<void> => {
    for (const hook of gateway.completePayment(payment.gatewayPaymentLinkId)) {
      await deliver(hook);
    }
  };

  beforeEach(async () => {
    handle = await createTestDatabase();
    gateway = new StubGateway();
    deps = {
      db: handle.db,
      gateway,
      merchantId: MERCHANT_ID,
      publicBaseUrl: 'https://merchant.example',
    };
    await seedCatalog(deps.db, 3);
    server = createServer(createApp(deps));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    server.close();
    await handle.close();
  });

  it('happy path: canned decision → client-custody purchase over Streamable HTTP → paid, Receipt verified', async () => {
    const result = await runLiveEvalTask(baseUrl, task(), {
      decide: cannedDecider([{ variantId: TEE, quantity: 1 }], 200_000),
      approvePayment: stubApprover,
      pollIntervalMs: 50,
    });

    expect(result.outcome).toEqual({
      kind: 'paid',
      orderId: expect.stringMatching(/^ord_/) as unknown as string,
      auditUrl: expect.stringContaining(`${baseUrl}/audit/ord_`) as unknown as string,
      receiptVerified: true,
    });
    expect(result.decision?.action).toBe('buy');
    // The transcript carries the decider's trace plus the runner's own marks.
    expect(result.transcript).toContain('canned decider ran');
    expect(result.transcript.some((line) => line.startsWith('payment link issued'))).toBe(true);
  });

  it('out-of-stock attempt surfaces the protocol refusal as a first-class outcome', async () => {
    const result = await runLiveEvalTask(baseUrl, task({ id: 'oos' }), {
      decide: cannedDecider([{ variantId: TEE, quantity: 99 }], 400_000_00),
      approvePayment: stubApprover,
      pollIntervalMs: 50,
    });

    expect(result.outcome.kind).toBe('refused');
    if (result.outcome.kind === 'refused') {
      expect(result.outcome.code).toBe('OUT_OF_STOCK');
      expect(result.outcome.tool).toBe('submit_payment');
    }
  });

  it('over-budget attempt is refused, not errored', async () => {
    const result = await runLiveEvalTask(baseUrl, task({ id: 'budget' }), {
      decide: cannedDecider([{ variantId: TEE, quantity: 1 }], 10_000), // ₹100 for a ₹1,299 tee
      approvePayment: stubApprover,
      pollIntervalMs: 50,
    });

    expect(result.outcome.kind).toBe('refused');
    if (result.outcome.kind === 'refused') {
      expect(result.outcome.code).toBe('OVER_BUDGET');
    }
  });

  it('a walk-away decision never opens a mandate chain', async () => {
    const result = await runLiveEvalTask(baseUrl, task({ id: 'walk' }), {
      decide: async () => ({
        decision: { action: 'walk_away', reasoning: 'nothing in budget' },
        transcript: [],
        costUsd: 0.01,
      }),
      approvePayment: async () => {
        throw new Error('must not be called');
      },
    });

    expect(result.outcome).toEqual({ kind: 'walked_away', reasoning: 'nothing in budget' });
    expect(result.costUsd).toBe(0.01);
  });

  it('dry run stops after link issuance and leaves the Order pending', async () => {
    const result = await runLiveEvalTask(baseUrl, task({ id: 'dry' }), {
      decide: cannedDecider([{ variantId: TEE, quantity: 1 }], 200_000),
      approvePayment: async () => {
        throw new DryRunStop();
      },
    });

    expect(result.outcome.kind).toBe('dry_run_stopped');
    if (result.outcome.kind === 'dry_run_stopped') {
      expect(result.outcome.paymentLinkUrl).toContain('https://stub.invalid/pay/');
      // The Order exists but nothing paid it: its audit chain is reachable and
      // the REST status face reports it unpaid.
      const status = await fetch(`${baseUrl}/audit/${result.outcome.orderId}`);
      expect(status.status).toBe(200);
    }
  });

  it("an approver's step log lands in the run transcript, not only on a terminal", async () => {
    // The 2026-08-27 live run failed on a payer-bot selector and left no
    // evidence behind, because the step log only ever reached console.log.
    const result = await runLiveEvalTask(baseUrl, task({ id: 'record' }), {
      decide: cannedDecider([{ variantId: TEE, quantity: 1 }], 200_000),
      approvePayment: async (payment, { record }) => {
        record('payer-bot: select UPI method: done via [role=button ^upi]');
        await stubApprover(payment);
      },
      pollIntervalMs: 50,
    });

    expect(result.outcome.kind).toBe('paid');
    expect(result.transcript).toContain('payer-bot: select UPI method: done via [role=button ^upi]');
  });

  it('page evidence attached to an approver failure is recorded with the error', async () => {
    const failure = Object.assign(new Error('select UPI method: no candidate locator matched'), {
      artifacts: ['/tmp/ord_x-failed-select-upi-method.png', '/tmp/ord_x-failed-select-upi-method.elements.txt'],
    });
    const result = await runLiveEvalTask(baseUrl, task({ id: 'evidence' }), {
      decide: cannedDecider([{ variantId: TEE, quantity: 1 }], 200_000),
      approvePayment: async (_payment, { record }) => {
        record('payer-bot: NO candidate matched — tried [role=button ^upi, text ^UPI$]');
        throw failure;
      },
    });

    expect(result.outcome).toEqual({
      kind: 'error',
      message: 'select UPI method: no candidate locator matched',
    });
    expect(result.transcript).toContain(
      'payer-bot evidence: /tmp/ord_x-failed-select-upi-method.png',
    );
    expect(result.transcript.some((line) => line.includes('NO candidate matched'))).toBe(true);
  });

  it('a decider crash is captured as an error outcome, not an unhandled throw', async () => {
    const result = await runLiveEvalTask(baseUrl, task({ id: 'crash' }), {
      decide: async () => {
        throw new Error('model quota exhausted');
      },
      approvePayment: stubApprover,
    });

    expect(result.outcome).toEqual({
      kind: 'error',
      message: 'decider failed: model quota exhausted',
    });
    expect(result.decision).toBeNull();
  });

  it('the suite runs tasks sequentially and the report renders them with the non-determinism banner', async () => {
    const run = await runLiveEvalSuite(
      `${baseUrl}/`, // trailing slash must be tolerated
      [task({ id: 'first' }), task({ id: 'second', instruction: 'walk away please' })],
      {
        decide: async (t) =>
          t.id === 'first'
            ? cannedDecider([{ variantId: TEE, quantity: 1 }], 200_000)(t, { mcpUrl: '' })
            : {
                decision: { action: 'walk_away', reasoning: 'told to' },
                transcript: [],
                costUsd: null,
              },
        approvePayment: stubApprover,
        pollIntervalMs: 50,
      },
    );

    expect(run.target).toBe(baseUrl);
    expect(run.results.map((r) => r.outcome.kind)).toEqual(['paid', 'walked_away']);

    const report = renderLiveReport(run);
    expect(report).toContain('Non-deterministic by nature');
    expect(report).toContain('separate from the scripted suite');
    expect(report).toContain('Run 1: first');
    expect(report).toContain('Run 2: second');
    expect(report).toContain('PAID');
    expect(report).toContain('WALKED AWAY');
  });
});
