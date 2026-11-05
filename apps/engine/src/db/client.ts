import { join } from 'node:path';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { schema } from './schema.ts';

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export type DbHandle = { db: Db; close: () => Promise<void> };

const MIGRATIONS = join(import.meta.dir, '..', '..', 'drizzle');

/** In-memory Postgres (pglite + pgvector) with migrations applied. Dev + tests. */
export async function createPgliteDb(): Promise<DbHandle> {
  const { PGlite } = await import('@electric-sql/pglite');
  const { vector } = await import('@electric-sql/pglite-pgvector');
  const { drizzle } = await import('drizzle-orm/pglite');
  const { migrate } = await import('drizzle-orm/pglite/migrator');
  const client = new PGlite({ extensions: { vector } });
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS });
  return { db: db as unknown as Db, close: () => client.close() };
}

/** Real Postgres (Neon). Migrations are run explicitly, not at boot. */
export async function createPostgresDb(url: string): Promise<DbHandle> {
  const { default: postgres } = await import('postgres');
  const { drizzle } = await import('drizzle-orm/postgres-js');
  const sql = postgres(url, { max: 10, ssl: url.includes('localhost') ? false : 'require' });
  const db = drizzle(sql, { schema });
  return { db: db as unknown as Db, close: () => sql.end() };
}

export async function migratePostgres(url: string): Promise<void> {
  const { default: postgres } = await import('postgres');
  const { drizzle } = await import('drizzle-orm/postgres-js');
  const { migrate } = await import('drizzle-orm/postgres-js/migrator');
  const sql = postgres(url, { max: 1 });
  await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS });
  await sql.end();
}
