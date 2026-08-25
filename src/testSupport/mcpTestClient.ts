import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { asc } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { auditEvents } from '../db/schema.js';

/**
 * Helpers shared by the MCP-seam integration suites, so every suite drives the
 * server through the same door a real buyer uses and reads the audit log back
 * the same way (by `seq`, never timestamp).
 */

export interface ToolCallResult {
  readonly isError: boolean;
  readonly body: Record<string, unknown>;
}

/** One tool call as a buyer would make it, with the JSON body parsed back out. */
export async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  return {
    isError: result.isError === true,
    body: JSON.parse(content[0]!.text) as Record<string, unknown>,
  };
}

/** Every audit event in `seq` order — the canonical way a suite reads the log. */
export async function auditChain(db: Database) {
  return db
    .select({
      type: auditEvents.type,
      orderId: auditEvents.orderId,
      payload: auditEvents.payload,
    })
    .from(auditEvents)
    .orderBy(asc(auditEvents.seq));
}
