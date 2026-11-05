import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { createPgliteDb, type DbHandle } from '../src/db/client.ts';

let h: DbHandle;
beforeAll(async () => {
  h = await createPgliteDb();
}, 120_000);
afterAll(async () => {
  await h?.close();
});

describe('migrations', () => {
  test('create all contract tables', async () => {
    const r = await h.db.execute(
      sql`select table_name from information_schema.tables where table_schema='public' order by 1`,
    );
    const names = (r as unknown as { rows: { table_name: string }[] }).rows.map(
      (x) => x.table_name,
    );
    for (const t of [
      'users',
      'devices',
      'enroll_codes',
      'conversations',
      'messages',
      'approvals',
      'approval_events',
      'guard_policies',
      'guard_decisions',
      'ledger_entries',
      'memories',
      'moods',
      'souls_changelog',
      'idempotency_keys',
      'webhook_events',
      'bots',
    ]) {
      expect(names).toContain(t);
    }
  });
});
