import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { createPgliteDb, type DbHandle } from '../src/db/client.ts';
import { approvalEvents } from '../src/db/schema.ts';
import { ApprovalsRepo } from '../src/repo/approvals.ts';

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
});
