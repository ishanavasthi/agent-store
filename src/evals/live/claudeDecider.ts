import { z } from 'zod';
import type { BuyerDecider, DeciderResult, LiveEvalTask } from './types.js';

/**
 * The real shopping brain: Claude via the Agent SDK, riding the developer's
 * Claude Code credentials (Max subscription — no ANTHROPIC_API_KEY involved;
 * the SDK resolves auth exactly as Claude Code itself does, per PLAN §3
 * "Agent SDK riding the same Max auth").
 *
 * Claude is given ONE tool: this merchant's own `get_product`, served by the
 * TARGET deployment over Streamable HTTP — so a live run proves a real Claude
 * client discovering a real remote catalog. The mandate mechanics stay in
 * T6's scripted client-custody buyer (see src/buyer/sdkBuyer.ts, whose header
 * sanctions exactly this split): Claude cannot hold an Ed25519 key, and
 * ADR-0004 requires the live buyer to sign locally, so Claude decides WHAT to
 * buy and the LocalSigner-backed machinery executes the chain it chose.
 *
 * The Agent SDK is a devDependency and is imported lazily: nothing in the
 * shipped server, the CI suite, or `npm start` ever loads it.
 */

const decisionSchema = z.union([
  z.object({
    action: z.literal('buy'),
    want: z.string().min(1),
    budgetPaise: z.number().int().positive(),
    items: z
      .array(z.object({ variantId: z.string().min(1), quantity: z.number().int().positive() }))
      .min(1),
    reasoning: z.string(),
  }),
  z.object({
    action: z.literal('walk_away'),
    reasoning: z.string(),
  }),
]);

/**
 * Pull the decision JSON out of a model's final answer. Tolerates markdown
 * fences and prose around the object; refuses anything that does not validate.
 */
export function parseBuyerDecision(text: string): z.infer<typeof decisionSchema> {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error(`no JSON object found in decision text: ${text.slice(0, 200)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (error) {
    throw new Error(
      `decision text is not valid JSON (${error instanceof Error ? error.message : String(error)}): ${text.slice(0, 200)}`,
    );
  }
  return decisionSchema.parse(parsed);
}

const MCP_SERVER_NAME = 'store';

function buildPrompt(task: LiveEvalTask): string {
  return [
    `You are a buyer agent shopping at a merchant's MCP storefront on a customer's behalf.`,
    ``,
    `Task: ${task.instruction}`,
    ``,
    `Your registered spend cap with this merchant is ${task.capPaise} paise (₹${(task.capPaise / 100).toFixed(2)}). You may never plan to spend more than that.`,
    ``,
    `First call the ${MCP_SERVER_NAME} server's get_product tool to see what is actually for sale (variantId, price in integer paise, stock). Then decide.`,
    ``,
    `Reply with ONLY a JSON object, no prose around it, in one of these two shapes:`,
    `{"action":"buy","want":"<what you are buying, in your words>","budgetPaise":<integer paise you authorize for this purchase, <= your cap>,"items":[{"variantId":"<id from the catalog>","quantity":<positive integer>}],"reasoning":"<why>"}`,
    `{"action":"walk_away","reasoning":"<why no purchase satisfies the task>"}`,
    ``,
    `Rules: only variantIds that appear in the catalog; budgetPaise must honestly reflect the task's budget constraints; if the task cannot be satisfied within its constraints, either attempt it anyway knowing the merchant will refuse (that refusal is a legitimate observation) or walk away — say which you chose in reasoning.`,
  ].join('\n');
}

export interface ClaudeDeciderOptions {
  /** Max agentic turns for the decision loop. */
  readonly maxTurns?: number;
  readonly log?: (line: string) => void;
}

/** Build the Agent SDK-backed decider. */
export function claudeDecider(options: ClaudeDeciderOptions = {}): BuyerDecider {
  return async (task, context): Promise<DeciderResult> => {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const log = options.log ?? (() => {});
    const transcript: string[] = [];
    let costUsd: number | null = null;
    let resultText: string | null = null;

    for await (const message of query({
      prompt: buildPrompt(task),
      options: {
        maxTurns: options.maxTurns ?? 10,
        systemPrompt:
          'You are an autonomous buyer agent evaluating a merchant storefront. ' +
          'Be decisive; do not ask the user anything.',
        mcpServers: {
          [MCP_SERVER_NAME]: { type: 'http', url: context.mcpUrl },
        },
        // The catalog tool is the ONLY tool this decision needs; everything
        // Claude Code would normally offer (Bash, file tools, web) is removed
        // so an unattended run cannot wander.
        allowedTools: [`mcp__${MCP_SERVER_NAME}__get_product`],
        disallowedTools: [
          'Bash',
          'Read',
          'Write',
          'Edit',
          'Glob',
          'Grep',
          'WebFetch',
          'WebSearch',
          'Task',
          'TodoWrite',
          'NotebookEdit',
          'Skill',
        ],
      },
    })) {
      if (message.type === 'assistant') {
        for (const block of message.message.content) {
          if (block.type === 'text' && block.text.trim() !== '') {
            transcript.push(`claude: ${block.text.trim()}`);
            log(`  claude: ${block.text.trim().split('\n')[0]}`);
          } else if (block.type === 'tool_use') {
            transcript.push(`claude → tool ${block.name}(${JSON.stringify(block.input)})`);
            log(`  claude → ${block.name}`);
          }
        }
      } else if (message.type === 'result') {
        if (message.subtype === 'success') {
          resultText = message.result;
          costUsd = message.total_cost_usd;
        } else {
          throw new Error(`Agent SDK run failed: ${message.subtype}`);
        }
      }
    }

    if (resultText === null) {
      throw new Error('Agent SDK run produced no result message');
    }
    const decision = parseBuyerDecision(resultText);
    transcript.push(`decision: ${JSON.stringify(decision)}`);
    return { decision, transcript, costUsd };
  };
}
