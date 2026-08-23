import { Pool, neonConfig } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import type { NeonQueryResultHKT } from 'drizzle-orm/neon-serverless';
import type { PgTransaction } from 'drizzle-orm/pg-core';
import type { ExtractTablesWithRelations } from 'drizzle-orm';
import ws from 'ws';
import * as schema from './schema.js';

/**
 * The pooled/WebSocket Neon driver, not the HTTP one.
 *
 * This is load-bearing, not a preference: `neon-http` issues each statement as
 * its own request and cannot hold an interactive transaction open. ADR-0003
 * requires every state change to commit in the same transaction as its audit
 * event, so the WebSocket driver is the only one that satisfies the guarantee.
 * `DATABASE_URL` must therefore be Neon's *pooled* connection string (its host
 * contains `-pooler`).
 */
neonConfig.webSocketConstructor = ws;

export type Database = ReturnType<typeof drizzle<typeof schema>>;

export type Transaction = PgTransaction<
  NeonQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

/**
 * Anything queries can run against — the pool or an open transaction. Domain
 * functions accept this so any caller can compose them into one transaction.
 */
export type Executor = Database | Transaction;

export interface DatabaseHandle {
  readonly db: Database;
  readonly pool: Pool;
  close(): Promise<void>;
}

export function createDatabase(databaseUrl: string): DatabaseHandle {
  const pool = new Pool({ connectionString: databaseUrl });
  const db = drizzle({ client: pool, schema });
  return {
    db,
    pool,
    close: () => pool.end(),
  };
}

export { schema };
