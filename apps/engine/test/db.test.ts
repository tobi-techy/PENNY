import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { createPgliteDb, type DbHandle } from '../src/db/client.ts';
import { approvalEvents } from '../src/db/schema.ts';
import { ApprovalsRepo } from '../src/repo/approvals.ts';

const DRIZZLE = join(import.meta.dir, '..', 'drizzle');

async function applyMigration(client: { exec: (s: string) => Promise<unknown> }, file: string) {
  const raw = readFileSync(join(DRIZZLE, file), 'utf8');
  for (const statement of raw.split('--> statement-breakpoint')) {
    if (statement.trim()) await client.exec(statement);
  }
}

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

  test('approval events stay in insertion order even on timestamp ties', async () => {
    await h.db.execute(sql`insert into users (id, handle) values ('usr_order_test', '+15550001')`);
    await h.db.execute(
      sql`insert into approvals (id, user_id, kind, plan, title, amount_display, facts, signer_id, receiver_id, actions, nonce, max_block_height, expires_at, status, plan_hash, card_token_hash)
          values ('apr_order_test', 'usr_order_test', 'send', '{}', 't', '$1', '[]', 'a.near', 'a.near', '[]', '1', '1', now(), 'pending', 'h', 'c')`,
    );
    const sameMs = new Date();
    // ids deliberately reverse-sorted: ordering must follow insertion (seq), not id or clock ties
    for (const [id, toStatus] of [
      ['evt_z', 'signed'],
      ['evt_m', 'relayed'],
      ['evt_a', 'settled'],
    ] as const) {
      await h.db.insert(approvalEvents).values({
        id,
        approvalId: 'apr_order_test',
        fromStatus: null,
        toStatus,
        createdAt: sameMs,
      });
    }
    const rows = await new ApprovalsRepo(h.db).events('apr_order_test');
    expect(rows.map((r) => r.toStatus)).toEqual(['signed', 'relayed', 'settled']);
    expect(rows.map((r) => r.seq)).toEqual([...rows.map((r) => r.seq)].sort((a, b) => a - b));
  });

  test('0002 keeps existing events in timestamp order, whoever scanned first', async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    const { vector } = await import('@electric-sql/pglite-pgvector');
    const client = new PGlite({ extensions: { vector } });
    try {
      await applyMigration(client, '0000_init.sql');
      await applyMigration(client, '0001_app_attest.sql');
      await client.exec(
        `insert into users (id, handle) values ('usr_backfill', '+15550002');
         insert into approvals (id, user_id, kind, plan, title, amount_display, facts, signer_id, receiver_id, actions, nonce, max_block_height, expires_at, status, plan_hash, card_token_hash)
         values ('apr_backfill', 'usr_backfill', 'send', '{}', 't', '$1', '[]', 'a.near', 'a.near', '[]', '1', '1', now(), 'pending', 'h', 'c');`,
      );
      // physical order is newest-first: the backfill must not trust it
      await client.exec(
        `insert into approval_events (id, approval_id, to_status, created_at) values
           ('evt_late',  'apr_backfill', 'settled', '2026-01-03T00:00:00Z'),
           ('evt_first', 'apr_backfill', 'signed',  '2026-01-01T00:00:00Z'),
           ('evt_mid',   'apr_backfill', 'relayed', '2026-01-02T00:00:00Z');`,
      );

      await applyMigration(client, '0002_approval_event_seq.sql');

      const ordered = await client.query<{ id: string; seq: string }>(
        'select id, seq from approval_events order by seq',
      );
      expect(ordered.rows.map((r) => r.id)).toEqual(['evt_first', 'evt_mid', 'evt_late']);

      // new rows continue after the backfilled range, in insertion order
      await client.exec(
        `insert into approval_events (id, approval_id, to_status) values
           ('evt_new_1', 'apr_backfill', 'failed'),
           ('evt_new_2', 'apr_backfill', 'cancelled');`,
      );
      const all = await client.query<{ id: string; seq: string }>(
        'select id, seq from approval_events order by seq',
      );
      expect(all.rows.map((r) => r.id)).toEqual([
        'evt_first',
        'evt_mid',
        'evt_late',
        'evt_new_1',
        'evt_new_2',
      ]);
      const seqs = all.rows.map((r) => Number(r.seq));
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    } finally {
      await client.close();
    }
  }, 60_000);
});
