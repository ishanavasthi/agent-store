import { migrate } from 'drizzle-orm/neon-serverless/migrator';
import { loadConfig } from '../config.js';
import { createDatabase } from './client.js';

/**
 * Applies the committed migrations in `drizzle/`.
 *
 * Run as part of Render's build step (see render.yaml) so a deploy can never
 * serve code against an older schema.
 */
async function run(): Promise<void> {
  const config = loadConfig();
  const { db, close } = createDatabase(config.databaseUrl);
  try {
    await migrate(db, { migrationsFolder: 'drizzle' });
    console.log('[migrate] up to date');
  } finally {
    await close();
  }
}

run().catch((error: unknown) => {
  console.error('[migrate] failed', error);
  process.exit(1);
});
