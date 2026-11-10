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

describe('PR #9 review: fresh prices', () => {
  async function investCard() {
    const r = await t.engine.services.approvals.createInvestApproval({
      userId: u.userId,
      bot: null,
      asset: 'ETH',
      amountUsd: '5',
      space: u.space,
    });
    if (r.decision !== 'allow_with_approval') throw new Error(`${r.decision}: ${r.reasons}`);
    return r;
  }

  test('at most 8 fresh prices per card, and they never use up Get a new card', async () => {
    const r = await investCard();
    const saved = t.clock.now;
    let refreshed = 0;
    try {
      for (let i = 0; i < 11; i += 1) {
        t.clock.now = new Date(t.clock.now.getTime() + 60_000);
        if (((await (await fresh(r.cardToken)).json()) as { refreshed: boolean }).refreshed)
          refreshed += 1;
      }
      expect(refreshed).toBe(8);
      // let it expire, then Get a new card still works
      t.clock.now = new Date(t.clock.now.getTime() + 5 * 60_000);
      await t.engine.services.approvals.expireDue();
      expect((await t.engine.services.approvals.renewByToken(r.cardToken)).approvalId).toBeTruthy();
    } finally {
      t.clock.now = saved;
    }
  });

  test('when Guard would refuse the new price, opening the card changes nothing and posts nothing', async () => {
    const r = await investCard();
    const texts = t.messaging.texts.length;
    await t.db.db.execute(
      sql`update guard_policies set per_tx_usd = '1' where user_id = ${u.userId}`,
    );
    const saved = t.clock.now;
    t.clock.now = new Date(saved.getTime() + 60_000);
    try {
      expect(await (await fresh(r.cardToken)).json()).toEqual({ refreshed: false });
      expect((await t.engine.repos.approvals.get(r.approvalId))?.status).toBe('pending');
      expect(t.messaging.texts.length).toBe(texts);
    } finally {
      t.clock.now = saved;
      await t.db.db.execute(
        sql`update guard_policies set per_tx_usd = '50' where user_id = ${u.userId}`,
      );
    }
  });

  test('never cancels an approval whose Face ID approve has started', async () => {
    const r = await investCard();
    await t.engine.repos.approvals.burnChallenge(r.approvalId, t.clock.now);
    const saved = t.clock.now;
    t.clock.now = new Date(saved.getTime() + 60_000);
    try {
      expect(await (await fresh(r.cardToken)).json()).toEqual({ refreshed: false });
      expect((await t.engine.repos.approvals.get(r.approvalId))?.status).toBe('pending');
      expect(await t.engine.repos.approvals.cancelIfUnused(r.approvalId, 'x')).toBe(false);
    } finally {
      t.clock.now = saved;
    }
  });

  test('two opens at once on an expired card: one fresh price, the card stays ready', async () => {
    const r = await investCard();
    const saved = t.clock.now;
    t.clock.now = new Date(saved.getTime() + 2 * 60_000);
    try {
      await t.engine.services.approvals.expireDue();
      const both = await Promise.all([fresh(r.cardToken), fresh(r.cardToken)]);
      const results = await Promise.all(both.map((x) => x.json()));
      expect(
        results.filter((x) => (x as { refreshed: boolean }).refreshed).length,
      ).toBeGreaterThanOrEqual(1);
      const view = await t.engine.services.approvals.getByToken(r.cardToken);
      expect(view.card.state).toBe('ready');
      expect(view.approval?.status).toBe('pending');
    } finally {
      t.clock.now = saved;
    }
  });
});

describe('PR #9 review: unfreeze', () => {
  test('a junk request does not use up the Unfreeze card', async () => {
    const f = await enrolledUser(t, '+15557000');
    await t.engine.services.approvals.freeze(f.userId);
    expect(await t.engine.services.approvals.startUnfreeze(f.userId, f.space)).toBe('card_sent');
    const token = tokenOf(t.messaging.cards.at(-1)?.card.url);
    const view = await t.engine.services.approvals.getByToken(token);
    const post = (body: unknown) =>
      t.engine.app.request(`/v1/cards/by-token/${token}/unfreeze`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': idemKey() },
        body: JSON.stringify(body),
      });
    expect((await post({ deviceId: f.deviceId, signature: 'A'.repeat(86) })).status).toBe(422);
    expect((await t.engine.services.approvals.getByToken(token)).card.state).toBe('ready');
    const { unfreezeMessage } = await import('@penny/shared');
    const ok = await post({
      deviceId: f.deviceId,
      signature: f.keys.sign(unfreezeMessage(view.card.id, view.unfreeze?.challenge as string)),
    });
    expect(ok.status).toBe(200);
  });

  test('frozen before any setup (no keys switched off): the text unfreezes', async () => {
    const user = await t.engine.repos.users.findOrCreateByHandle('+15557001');
    await t.engine.services.approvals.freeze(user.id);
    expect(
      await t.engine.services.approvals.startUnfreeze(user.id, {
        spaceId: 's',
        userHandle: '+15557001',
      }),
    ).toBe('unfrozen');
    expect((await t.engine.repos.users.byId(user.id))?.frozenAt).toBeNull();
  });
});

function tokenOf(url: string | undefined): string {
  return /\/a\/([A-Za-z0-9_-]{43})/.exec(url ?? '')?.[1] ?? '';
}
