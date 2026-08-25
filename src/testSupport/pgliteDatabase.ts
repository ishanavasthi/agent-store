import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { Database } from '../db/client.js';
import * as schema from '../db/schema.js';

/**
 * An embedded, in-memory Postgres for tests — real SQL, real transactions,
 * the real committed migrations (including 0001's append-only triggers on
 * `audit_events`), zero network. This directory is excluded from
 * `tsconfig.build.json`, so PGlite stays a devDependency.
 */

export interface TestDatabaseHandle {
  readonly db: Database;
  close(): Promise<void>;
}

export async function createTestDatabase(): Promise<TestDatabaseHandle> {
  const client = new PGlite();
  const db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder: 'drizzle' });
  // `Database` is nominally the Neon driver's type; the PGlite instance has
  // the same query/transaction surface the domain code uses. One cast here,
  // in test support, rather than widening the production type for a test.
  return { db: db as unknown as Database, close: () => client.close() };
}
