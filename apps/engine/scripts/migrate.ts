/**
 * Apply the Drizzle migrations to DATABASE_URL. Run once per deploy, before
 * starting the engine: the Postgres path does not migrate at boot.
 *
 * A fresh database runs 0000..0009. A database that ran an earlier shape of the
 * bills branch must be dropped and recreated first: drizzle applies by journal
 * timestamp, so a renumbered history can silently skip main's migrations.
 */
import { migratePostgres } from '../src/db/client.ts';

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error('DATABASE_URL is unset');
  process.exit(1);
}

await migratePostgres(url);
console.log('migrations applied');
