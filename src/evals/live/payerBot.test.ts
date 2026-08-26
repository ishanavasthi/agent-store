import { describe, expect, it } from 'vitest';
import { approvePaymentLink, PayerBotError, TEST_UPI_SUCCESS_VPA } from './payerBot.js';

/**
 * The payer-bot's CI-safe surface: dry-run mode and URL validation. The live
 * path (a real Chromium against Razorpay's hosted page) is exercised only by
 * the human-triggered runs — a browser in CI would test Playwright, not us.
 */
describe('approvePaymentLink', () => {
  it('dry run validates the link and stops before any browser exists', async () => {
    const report = await approvePaymentLink('https://rzp.io/rzp/abc123', { dryRun: true });

    expect(report.mode).toBe('dry-run');
    expect(report.url).toBe('https://rzp.io/rzp/abc123');
    expect(report.steps.at(-1)).toContain('stopping before any browser launch');
  });

  it('refuses a non-URL outright', async () => {
    await expect(approvePaymentLink('not a link', { dryRun: true })).rejects.toThrow(PayerBotError);
  });

  it('refuses a non-http(s) scheme, dry run or not', async () => {
    await expect(approvePaymentLink('file:///etc/passwd', { dryRun: true })).rejects.toThrow(
      /non-http/,
    );
  });

  it('defaults to the documented test-mode success VPA', () => {
    // Pinned: the whole live suite depends on Razorpay's magic test VPAs
    // (razorpay.com/docs/payments/payments/test-upi-details).
    expect(TEST_UPI_SUCCESS_VPA).toBe('success@razorpay');
  });
});
