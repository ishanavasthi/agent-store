import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import type { Database } from '../db/client.js';
import * as schema from '../db/schema.js';

/**
 * An embedded, in-memory Postgres for tests — real SQL, real transactions,
 * the real committed migrations (including 0001's append-only triggers on
 * `audit_events`), zero network. This directory is excluded from
 * `tsconfig.build.json`'s entry points, but T8's rehearsal script imports it,
 * which pulls it into the compiled `dist` anyway. PGlite stays a devDependency
 * regardless: nothing the *server* runtime loads (`dist/index.js`) reaches this
 * file — only tests and the on-demand `npm run failure:*` rehearsals do, and
 * both run where devDependencies are installed.
 */

export interface TestDatabaseHandle {
  readonly db: Database;
  close(): Promise<void>;
}

/**
 * Resolved from this file, not the cwd: any suite reusing this helper (T5, T15)
 * may be invoked from a different directory, and a cwd-relative folder fails by
 * migrating nothing rather than by throwing.
 */
const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

export async function createTestDatabase(): Promise<TestDatabaseHandle> {
  const client = new PGlite();
  const db = drizzle({ client, schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  // `Database` is nominally the Neon driver's type; the PGlite instance has
  // the same query/transaction surface the domain code uses. One cast here,
  // in test support, rather than widening the production type for a test.
  return { db: db as unknown as Database, close: () => client.close() };
}
