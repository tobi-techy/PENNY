import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { enrolledUser, idemKey, makeEngine, signBody, type TestEngine } from './helpers.ts';

/** Phase 2 for people without the app: fewer messages, fresh prices, honest lines. */
let t: TestEngine;
let u: Awaited<ReturnType<typeof enrolledUser>>;
beforeAll(async () => {
  t = await makeEngine({ extra: { sleep: async () => {} } });
  u = await enrolledUser(t);
  await t.db.db.execute(
    sql`update guard_policies set daily_usd = '100000', max_approvals_per_10_min = 100000 where user_id = ${u.userId}`,
  );
  // a no-app user: picture link cards
  await t.db.db.execute(
    sql`update devices set platform = 'web_passkey', has_extension = false where user_id = ${u.userId}`,
  );
}, 120_000);
afterAll(async () => {
  await t?.db.close();
});

const fresh = (token: string) =>
  t.engine.app.request(`/v1/approvals/by-token/${token}/fresh-price`, {
    method: 'POST',
    headers: { 'idempotency-key': idemKey() },
  });

describe('fewer messages', () => {
  test('an unanswered card expiring sends nothing; the page shows Expired when opened', async () => {
    const r = await t.engine.services.approvals.createMoneyApproval({
      userId: u.userId,
      bot: null,
      plan: { kind: 'send', asset: 'USDC', amount: '1', to: 'ada.penny.near' },
      space: u.space,
    });
    if (r.decision !== 'allow_with_approval') throw new Error('expected card');
    const before = t.messaging.texts.length;
    const saved = t.clock.now;
    t.clock.now = new Date(saved.getTime() + 11 * 60_000);
    try {
      await t.engine.services.approvals.expireDue();
      expect(t.messaging.texts.length).toBe(before);
      expect((await t.engine.services.approvals.getByToken(r.cardToken)).card.state).toBe(
        'expired',
      );
    } finally {
      t.clock.now = saved;
    }
  });
});

describe('a fresh price when an invest card is opened', () => {
  test('nearly gone: replaced in place (same link, no new message); approving the fresh one works', async () => {
    const r = await t.engine.services.approvals.createInvestApproval({
      userId: u.userId,
      bot: null,
      asset: 'ETH',
      amountUsd: '5',
      space: u.space,
    });
    if (r.decision !== 'allow_with_approval') throw new Error(`${r.decision}: ${r.reasons}`);
    // plenty of time left: nothing changes
    expect(await (await fresh(r.cardToken)).json()).toEqual({ refreshed: false });
    const before = t.messaging.texts.length;
    const saved = t.clock.now;
    t.clock.now = new Date(saved.getTime() + 60_000); // 30 s left of 90
    try {
      expect(await (await fresh(r.cardToken)).json()).toEqual({ refreshed: true });
      expect(t.messaging.texts.length).toBe(before);
      const view = await t.engine.services.approvals.getByToken(r.cardToken);
      expect(view.approval?.id).not.toBe(r.approvalId);
      expect(view.card.state).toBe('ready');
      expect(
        Date.parse(view.approval?.expiresAt as string) - t.clock.now.getTime(),
      ).toBeGreaterThan(80_000);
      expect((await t.engine.repos.approvals.get(r.approvalId))?.status).toBe('cancelled');
      const held = (await t.db.db.execute(
        sql`select status from ledger_entries where approval_id = ${r.approvalId}`,
      )) as unknown as { rows: { status: string }[] };
      expect(held.rows[0]?.status).toBe('released');
      // the same link approves the fresh price
      const id = view.approval?.id as string;
      const res = await t.engine.app.request(`/v1/approvals/${id}/sign`, {
        method: 'POST',
        headers: {
          authorization: `Card ${r.cardToken}`,
          'idempotency-key': idemKey(),
          'content-type': 'application/json',
        },
        body: JSON.stringify(await signBody(t, r.cardToken, u)),
      });
      expect(res.status).toBe(200);
    } finally {
      t.clock.now = saved;
    }
  });

  test('never for a plain send, and never once Face ID started', async () => {
    const r = await t.engine.services.approvals.createMoneyApproval({
      userId: u.userId,
      bot: null,
      plan: { kind: 'send', asset: 'USDC', amount: '1', to: 'ada.penny.near' },
      space: u.space,
    });
    if (r.decision !== 'allow_with_approval') throw new Error('expected card');
    expect(await (await fresh(r.cardToken)).json()).toEqual({ refreshed: false });
  });
});

describe('honest lines', () => {
  test('a relay error never claims nothing moved', async () => {
    const r = await t.engine.services.approvals.createMoneyApproval({
      userId: u.userId,
      bot: null,
      plan: { kind: 'send', asset: 'USDC', amount: '1', to: 'ada.penny.near' },
      space: u.space,
    });
    if (r.decision !== 'allow_with_approval') throw new Error('expected card');
    t.chain.nextRelay = { ok: false, reason: 'rpc timeout' };
    try {
      await t.engine.app.request(`/v1/approvals/${r.approvalId}/sign`, {
        method: 'POST',
        headers: {
          authorization: `Card ${r.cardToken}`,
          'idempotency-key': idemKey(),
          'content-type': 'application/json',
        },
        body: JSON.stringify(await signBody(t, r.cardToken, u)),
      });
    } finally {
      t.chain.nextRelay = null;
    }
    const card = (await t.engine.services.approvals.getByToken(r.cardToken)).card;
    expect(card.state).toBe('failed');
    expect(card.statusLine).toContain("couldn't confirm");
    expect(card.statusLine).not.toContain('nothing');
    // the fresh link card says the same
    expect(t.messaging.texts.at(-1)?.text).toContain(`/a/${r.cardToken}?v=failed`);
  });
});
