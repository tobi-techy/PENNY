import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Approval, ApprovalStatusResponse, type MoneyPlan } from '@penny/shared';
import { sql } from 'drizzle-orm';
import { enrolledUser, idemKey, makeEngine, type TestEngine } from './helpers.ts';

let t: TestEngine;
let u: Awaited<ReturnType<typeof enrolledUser>>;

beforeAll(async () => {
  t = await makeEngine();
  u = await enrolledUser(t);
  // this suite creates many approvals for one user; the caps themselves are tested in guard.test.ts
  await t.db.db.execute(
    sql`update guard_policies set daily_usd = '100000', max_approvals_per_10_min = 100000 where user_id = ${u.userId}`,
  );
}, 120_000);
afterAll(async () => {
  await t?.db.close();
});

const send = (amount: string, to = 'ada.penny.near'): MoneyPlan => ({
  kind: 'send',
  asset: 'USDC',
  amount,
  to,
});

async function create(plan: MoneyPlan = send('10')) {
  const r = await t.engine.services.approvals.createMoneyApproval({
    userId: u.userId,
    bot: null,
    plan,
    space: u.space,
  });
  if (r.decision !== 'allow_with_approval')
    throw new Error(`expected allow, got ${r.decision}: ${r.reasons}`);
  return r;
}

const req = (path: string, init: RequestInit & { token?: string; idem?: string } = {}) => {
  const headers = new Headers(init.headers);
  if (init.token) headers.set('authorization', `Card ${init.token}`);
  if (init.idem) headers.set('idempotency-key', init.idem);
  if (init.body) headers.set('content-type', 'application/json');
  return t.engine.app.request(path, { ...init, headers });
};

describe('create money approval', () => {
  test('Guard allows, card sent with live:true and token in URL fragment only', async () => {
    const before = t.messaging.cards.length;
    const r = await create();
    expect(t.messaging.cards.length).toBe(before + 1);
    const card = t.messaging.cards.at(-1)?.card;
    expect(card?.live).toBe(true);
    expect(card?.url).toBe(`https://penny.test/a/${r.approvalId}#t=${r.cardToken}`);
    const row = await t.engine.repos.approvals.get(r.approvalId);
    expect(row?.cardTokenHash).not.toBe(r.cardToken);
    expect(row?.status).toBe('pending');
    expect(row && row.expiresAt.getTime() - t.clock.now.getTime()).toBeLessThanOrEqual(120_000);
  });
  test('Guard block creates no approval and no card', async () => {
    const before = t.messaging.cards.length;
    const r = await t.engine.services.approvals.createMoneyApproval({
      userId: u.userId,
      bot: null,
      plan: send('500'),
      space: u.space,
    });
    expect(r.decision).toBe('block');
    expect(t.messaging.cards.length).toBe(before);
    expect(await t.engine.services.mood.get(u.userId, 'guard')).toBe('blocked');
  });
  test('user without a device gets needs_more_info', async () => {
    const other = await t.engine.repos.users.findOrCreateByHandle('+15559999');
    const r = await t.engine.services.approvals.createMoneyApproval({
      userId: other.id,
      bot: null,
      plan: send('1'),
      space: u.space,
    });
    expect(r.decision).toBe('needs_more_info');
  });
});

describe('GET /v1/approvals/:id (card token auth)', () => {
  test('returns the Approval contract shape, no secrets', async () => {
    const r = await create();
    const res = await req(`/v1/approvals/${r.approvalId}`, { token: r.cardToken });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Approval;
    expect(Approval.safeParse(body).success).toBe(true);
    expect(JSON.stringify(body)).not.toContain(r.cardToken);
    expect(JSON.stringify(body)).not.toContain('cardTokenHash');
    expect(body.signerId).toBe(u.accountId);
  });
  test('wrong token, missing token and unknown id all 401 the same', async () => {
    const r = await create();
    const other = await create();
    for (const res of [
      await req(`/v1/approvals/${r.approvalId}`, { token: other.cardToken }),
      await req(`/v1/approvals/${r.approvalId}`),
      await req('/v1/approvals/apr_01JC0000000000000000000000', { token: r.cardToken }),
      await req('/v1/approvals/not-an-id', { token: r.cardToken }),
    ]) {
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'unauthorized' });
    }
  });
});

describe('submit', () => {
  test('happy path: pending -> signed -> relayed -> settled, audit trail append-only', async () => {
    const r = await create(send('5'));
    const res = await req(`/v1/approvals/${r.approvalId}/submit`, {
      method: 'POST',
      token: r.cardToken,
      idem: idemKey(),
      body: JSON.stringify({ signedDelegateAction: 'AAAAAAAA' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'settled' });
    const events = await t.engine.repos.approvals.events(r.approvalId);
    expect(events.map((e) => e.toStatus)).toEqual(['pending', 'signed', 'relayed', 'settled']);
    expect(t.chain.verifyCalls).toContain(r.approvalId);
    // status endpoint
    const st = await req(`/v1/approvals/${r.approvalId}/status`, { token: r.cardToken });
    const sb = (await st.json()) as ApprovalStatusResponse;
    expect(ApprovalStatusResponse.safeParse(sb).success).toBe(true);
    expect(sb.status).toBe('settled');
    expect(sb.txHash).toMatch(/^dry_/);
    // card edited in place
    expect(
      t.messaging.edits.some(
        (e) => e.handle.approvalId === r.approvalId && e.card.subcaption === 'done ✓',
      ),
    ).toBe(true);
    // approval_events is append-only at the DB level
    await expect(
      Promise.resolve(t.db.db.execute(sql`update approval_events set reason = 'x'`)),
    ).rejects.toThrow();
    await expect(
      Promise.resolve(t.db.db.execute(sql`delete from approval_events`)),
    ).rejects.toThrow();
  });

  test('approvals are single use: re-submit with a new key -> 409', async () => {
    const r = await create(send('1'));
    const body = JSON.stringify({ signedDelegateAction: 'AAAAAAAA' });
    expect(
      (
        await req(`/v1/approvals/${r.approvalId}/submit`, {
          method: 'POST',
          token: r.cardToken,
          idem: idemKey(),
          body,
        })
      ).status,
    ).toBe(200);
    const again = await req(`/v1/approvals/${r.approvalId}/submit`, {
      method: 'POST',
      token: r.cardToken,
      idem: idemKey(),
      body,
    });
    expect(again.status).toBe(409);
  });

  test('concurrent submits relay once', async () => {
    const r = await create(send('1'));
    const body = JSON.stringify({ signedDelegateAction: 'AAAAAAAA' });
    const before = t.chain.relayCalls.length;
    const results = await Promise.all(
      [1, 2, 3].map(() =>
        req(`/v1/approvals/${r.approvalId}/submit`, {
          method: 'POST',
          token: r.cardToken,
          idem: idemKey(),
          body,
        }),
      ),
    );
    const ok = results.filter((x) => x.status === 200).length;
    expect(ok).toBe(1);
    expect(t.chain.relayCalls.length - before).toBe(1);
  });

  test('idempotency: same key + same body replays; same key + different body -> 422; missing key -> 400', async () => {
    const r = await create(send('1'));
    const key = idemKey();
    const body = JSON.stringify({ signedDelegateAction: 'AAAAAAAA' });
    const a = await req(`/v1/approvals/${r.approvalId}/submit`, {
      method: 'POST',
      token: r.cardToken,
      idem: key,
      body,
    });
    const b = await req(`/v1/approvals/${r.approvalId}/submit`, {
      method: 'POST',
      token: r.cardToken,
      idem: key,
      body,
    });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.headers.get('idempotent-replayed')).toBe('true');
    const c = await req(`/v1/approvals/${r.approvalId}/submit`, {
      method: 'POST',
      token: r.cardToken,
      idem: key,
      body: JSON.stringify({ signedDelegateAction: 'BBBBBBBB' }),
    });
    expect(c.status).toBe(422);
    const d = await req(`/v1/approvals/${r.approvalId}/submit`, {
      method: 'POST',
      token: r.cardToken,
      body,
    });
    expect(d.status).toBe(400);
  });

  test('delegate action mismatch -> 422 and stays pending', async () => {
    const r = await create(send('1'));
    t.chain.nextVerify = { ok: false, reason: 'receiver mismatch' };
    const res = await req(`/v1/approvals/${r.approvalId}/submit`, {
      method: 'POST',
      token: r.cardToken,
      idem: idemKey(),
      body: JSON.stringify({ signedDelegateAction: 'AAAAAAAA' }),
    });
    t.chain.nextVerify = { ok: true };
    expect(res.status).toBe(422);
    expect((await t.engine.repos.approvals.get(r.approvalId))?.status).toBe('pending');
  });

  test('relay failure -> failed, ledger released', async () => {
    const r = await create(send('1'));
    t.chain.nextRelay = { ok: false, reason: 'rpc down' };
    const res = await req(`/v1/approvals/${r.approvalId}/submit`, {
      method: 'POST',
      token: r.cardToken,
      idem: idemKey(),
      body: JSON.stringify({ signedDelegateAction: 'AAAAAAAA' }),
    });
    t.chain.nextRelay = null;
    expect(res.status).toBe(502);
    expect((await t.engine.repos.approvals.get(r.approvalId))?.status).toBe('failed');
  });

  test('unknown body keys rejected; planSignature on a money approval rejected', async () => {
    const r = await create(send('1'));
    const extra = await req(`/v1/approvals/${r.approvalId}/submit`, {
      method: 'POST',
      token: r.cardToken,
      idem: idemKey(),
      body: JSON.stringify({ signedDelegateAction: 'AAAAAAAA', receiverId: 'evil.near' }),
    });
    expect(extra.status).toBe(400);
    const wrong = await req(`/v1/approvals/${r.approvalId}/submit`, {
      method: 'POST',
      token: r.cardToken,
      idem: idemKey(),
      body: JSON.stringify({ planSignature: 'A'.repeat(86) }),
    });
    expect(wrong.status).toBe(400);
  });
});

describe('decline, expiry, guard re-check', () => {
  test('decline -> cancelled, then submit -> 409', async () => {
    const r = await create(send('1'));
    const d = await req(`/v1/approvals/${r.approvalId}/decline`, {
      method: 'POST',
      token: r.cardToken,
      idem: idemKey(),
      body: '{}',
    });
    expect(d.status).toBe(200);
    expect(await d.json()).toEqual({ status: 'cancelled' });
    const s = await req(`/v1/approvals/${r.approvalId}/submit`, {
      method: 'POST',
      token: r.cardToken,
      idem: idemKey(),
      body: JSON.stringify({ signedDelegateAction: 'AAAAAAAA' }),
    });
    expect(s.status).toBe(409);
  });

  test('expired approval: submit -> 410 and status becomes expired', async () => {
    const r = await create(send('1'));
    const saved = t.clock.now;
    t.clock.now = new Date(saved.getTime() + 121_000);
    const s = await req(`/v1/approvals/${r.approvalId}/submit`, {
      method: 'POST',
      token: r.cardToken,
      idem: idemKey(),
      body: JSON.stringify({ signedDelegateAction: 'AAAAAAAA' }),
    });
    expect(s.status).toBe(410);
    expect((await t.engine.repos.approvals.get(r.approvalId))?.status).toBe('expired');
    // read grace: status still visible
    const st = await req(`/v1/approvals/${r.approvalId}/status`, { token: r.cardToken });
    expect(st.status).toBe(200);
    t.clock.now = saved;
  });

  test('sweeper expires due approvals', async () => {
    const r = await create(send('1'));
    const saved = t.clock.now;
    t.clock.now = new Date(saved.getTime() + 200_000);
    expect(await t.engine.services.approvals.expireDue()).toBeGreaterThanOrEqual(1);
    expect((await t.engine.repos.approvals.get(r.approvalId))?.status).toBe('expired');
    t.clock.now = saved;
  });

  test('Guard re-runs at submit: policy tightened after card -> cancelled', async () => {
    const r = await create(send('8'));
    await t.db.db.execute(
      sql`update guard_policies set per_tx_usd = '5' where user_id = ${u.userId}`,
    );
    const s = await req(`/v1/approvals/${r.approvalId}/submit`, {
      method: 'POST',
      token: r.cardToken,
      idem: idemKey(),
      body: JSON.stringify({ signedDelegateAction: 'AAAAAAAA' }),
    });
    await t.db.db.execute(
      sql`update guard_policies set per_tx_usd = '50' where user_id = ${u.userId}`,
    );
    expect(s.status).toBe(409);
    expect((await t.engine.repos.approvals.get(r.approvalId))?.status).toBe('cancelled');
  });

  test('daily cap counts reservations from earlier approvals (rolling ledger)', async () => {
    const fresh = await enrolledUser(t, '+15550777');
    await t.db.db.execute(
      sql`update guard_policies set allowlist = '{ada.penny.near}' where user_id = ${fresh.userId}`,
    );
    const mk = (amount: string) =>
      t.engine.services.approvals.createMoneyApproval({
        userId: fresh.userId,
        bot: null,
        plan: send(amount),
        space: fresh.space,
      });
    expect((await mk('45')).decision).toBe('allow_with_approval');
    expect((await mk('45')).decision).toBe('allow_with_approval');
    const third = await mk('15');
    expect(third.decision).toBe('block');
    expect(third.reasons.join(' ')).toContain('$10.00 left');
  });

  test('velocity: 6th approval inside 10 minutes is blocked', async () => {
    const v = await enrolledUser(t, '+15550888');
    const mk = () =>
      t.engine.services.approvals.createMoneyApproval({
        userId: v.userId,
        bot: null,
        plan: send('1'),
        space: v.space,
      });
    for (let i = 0; i < 5; i++) expect((await mk()).decision).toBe('allow_with_approval');
    expect((await mk()).decision).toBe('block');
  });
});
