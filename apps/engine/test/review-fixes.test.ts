import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { FakeConnector } from '../src/connectors/composio.ts';
import {
  enrolledUser,
  idemKey,
  makeEngine,
  scriptedModel,
  signBody,
  type TestEngine,
  tokenFromUrl,
} from './helpers.ts';

/** Regressions for the PR #7 review findings. */
let t: TestEngine;
let u: Awaited<ReturnType<typeof enrolledUser>>;
const fake = new FakeConnector();
beforeAll(async () => {
  t = await makeEngine({ connectors: fake, extra: { sleep: async () => {} } });
  u = await enrolledUser(t);
  await t.db.db.execute(
    sql`update guard_policies set daily_usd = '100000', max_approvals_per_10_min = 100000 where user_id = ${u.userId}`,
  );
}, 120_000);
afterAll(async () => {
  await t?.db.close();
});

const send = (amount = '1') =>
  t.engine.services.approvals.createMoneyApproval({
    userId: u.userId,
    bot: null,
    plan: { kind: 'send', asset: 'USDC', amount, to: 'ada.penny.near' },
    space: u.space,
  });
const press = (token: string, buttonId: string) =>
  t.engine.app.request(`/v1/cards/by-token/${token}/press`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': idemKey() },
    body: JSON.stringify({ buttonId }),
  });
const later = async (ms: number, fn: () => Promise<void>) => {
  const saved = t.clock.now;
  t.clock.now = new Date(saved.getTime() + ms);
  try {
    await fn();
  } finally {
    t.clock.now = saved;
  }
};

describe('buttons on expired cards', () => {
  test('Get a new card still works an hour after the card expired', async () => {
    const r = await send();
    if (r.decision !== 'allow_with_approval') throw new Error('expected card');
    await later(70 * 60_000, async () => {
      await t.engine.services.approvals.expireDue();
      const res = await press(r.cardToken, 'renew');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { renewedApprovalId: string | null };
      expect(body.renewedApprovalId).toBeTruthy();
    });
  });

  test('Undo or Send on an expired card is refused', async () => {
    const r = await send();
    if (r.decision !== 'allow_with_approval') throw new Error('expected card');
    await later(70 * 60_000, async () => {
      expect((await press(r.cardToken, 'decline')).status).toBe(401);
    });
  });

  test('a failed approval is never re-sent by Get a new card', async () => {
    const r = await send();
    if (r.decision !== 'allow_with_approval') throw new Error('expected card');
    await t.db.db.execute(sql`update approvals set status = 'failed' where id = ${r.approvalId}`);
    await expect(t.engine.services.approvals.renewByToken(r.cardToken)).rejects.toMatchObject({
      code: 'not_expired',
    });
  });
});

describe('the challenge is burned: no approval is left half-done', () => {
  test('an unexpected error after the checks expires the approval and sends a new card', async () => {
    const r = await send();
    if (r.decision !== 'allow_with_approval') throw new Error('expected card');
    const body = await signBody(t, r.cardToken, u);
    const orig = t.chain.verifyDelegateAction.bind(t.chain);
    t.chain.verifyDelegateAction = async () => {
      throw new Error('rpc down');
    };
    try {
      const res = await t.engine.app.request(`/v1/approvals/${r.approvalId}/sign`, {
        method: 'POST',
        headers: {
          authorization: `Card ${r.cardToken}`,
          'idempotency-key': idemKey(),
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(500);
    } finally {
      t.chain.verifyDelegateAction = orig;
    }
    expect((await t.engine.repos.approvals.get(r.approvalId))?.status).toBe('expired');
    expect((await t.engine.repos.approvals.byReissuedFrom(r.approvalId))?.status).toBe('pending');
  });
});

describe('a draft is sent once', () => {
  test('two Send presses at once: one approval, the other refused', async () => {
    t.setModels(
      scriptedModel([{ tool: 'route', input: { bot: 'penny', reason: 'email' } }]),
      scriptedModel([
        {
          tool: 'draft_email',
          input: { toName: 'Amara', toEmail: 'amara@example.com', subject: 'Invoice', body: 'Hi' },
        },
        { text: 'drafted.' },
      ]),
    );
    await t.engine.services.crew.handle(u.userId, u.space, 'email Amara the invoice', {
      enrolled: true,
    });
    const token = tokenFromUrl(t.messaging.cards.at(-1)?.card.url);
    const before = (await t.engine.repos.approvals.listForUser(u.userId, 50)).length;
    const results = await Promise.all([press(token, 'send'), press(token, 'send')]);
    expect(results.map((x) => x.status).sort()).toEqual([200, 409]);
    expect((await t.engine.repos.approvals.listForUser(u.userId, 50)).length).toBe(before + 1);
  });
});

describe('a live card that fails to send', () => {
  test('falls back to the picture link so the user still gets the card', async () => {
    const orig = t.messaging.sendCard.bind(t.messaging);
    t.messaging.sendCard = async () => {
      throw new Error('spectrum down');
    };
    try {
      const r = await send();
      if (r.decision !== 'allow_with_approval') throw new Error('expected card');
      expect(t.messaging.texts.at(-1)?.text).toBe(`https://penny.test/a/${r.cardToken}`);
    } finally {
      t.messaging.sendCard = orig;
    }
  });
});

describe('mainnet enrollment needs App Attest', () => {
  test('web_passkey is not a way around it', async () => {
    const t2 = await makeEngine({ extra: { attestRequire: true } });
    const user = await t2.engine.repos.users.findOrCreateByHandle('+15556000');
    const { code } = await t2.engine.services.enroll.issue(user.id, '+15556000');
    await expect(
      t2.engine.services.enroll.enroll({
        enrollCode: code,
        publicKeyEd25519: 'A'.repeat(42) + 'Q',
        platform: 'web_passkey',
        passkey: {} as never,
        passkeyChallengeId: 'atch_x',
      }),
    ).rejects.toMatchObject({ code: 'attest_required' });
    await t2.db.close();
  }, 60_000);
});
