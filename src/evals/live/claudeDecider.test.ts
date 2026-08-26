import { describe, expect, it } from 'vitest';
import { parseBuyerDecision } from './claudeDecider.js';

/**
 * The deterministic half of the Claude decider: turning a model's final
 * answer into a validated BuyerDecision. The model half is live-run-only.
 */
describe('parseBuyerDecision', () => {
  const buy = {
    action: 'buy',
    want: 'a black tee',
    budgetPaise: 150000,
    items: [{ variantId: 'var_x', quantity: 1 }],
    reasoning: 'best match under budget',
  };

  it('parses a bare JSON object', () => {
    expect(parseBuyerDecision(JSON.stringify(buy))).toEqual(buy);
  });

  it('parses JSON wrapped in a markdown fence and prose', () => {
    const text = `Here is my decision:\n\n\`\`\`json\n${JSON.stringify(buy, null, 2)}\n\`\`\`\nDone.`;
    expect(parseBuyerDecision(text)).toEqual(buy);
  });

  it('parses a walk-away', () => {
    const decision = parseBuyerDecision('{"action":"walk_away","reasoning":"nothing fits"}');
    expect(decision).toEqual({ action: 'walk_away', reasoning: 'nothing fits' });
  });

  it('rejects text with no JSON object', () => {
    expect(() => parseBuyerDecision('I could not decide.')).toThrow(/no JSON object/);
  });

  it('rejects malformed JSON', () => {
    expect(() => parseBuyerDecision('{"action":"buy",')).toThrow(/no JSON object|not valid JSON/);
  });

  it('rejects a buy with no items or a non-integer budget', () => {
    expect(() =>
      parseBuyerDecision(
        JSON.stringify({ ...buy, items: [] }),
      ),
    ).toThrow();
    expect(() =>
      parseBuyerDecision(
        JSON.stringify({ ...buy, budgetPaise: 1500.5 }),
      ),
    ).toThrow();
  });
});
