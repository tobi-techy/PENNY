import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type Approval, type CreateBotPlan, planApprovalMessage } from '@penny/shared';
import { sql } from 'drizzle-orm';
import { BUILT_IN_BOTS } from '../src/brain/bots.ts';
import { createRegistry } from '../src/brain/tools.ts';
import type { BotRow } from '../src/repo/bots.ts';
import { enrolledUser, idemKey, makeEngine, scriptedModel, type TestEngine } from './helpers.ts';

let t: TestEngine;
let u: Awaited<ReturnType<typeof enrolledUser>>;
beforeAll(async () => {
  t = await makeEngine();
  u = await enrolledUser(t);
}, 120_000);
afterAll(async () => {
  await t?.db.close();
});

const soul = '# Bot\nI help with one thing, carefully, and I keep it short.';
const plan = (over: Partial<CreateBotPlan>): CreateBotPlan => ({
  kind: 'create_bot',
  slug: 'gh-buddy',
  name: 'GH Buddy',
  soulMd: soul,
  toolIds: ['read_github'],
  permissions: { canMoveMoney: false },
  ...over,
});
const activeSlugs = async () => (await t.engine.repos.bots.activeFor(u.userId)).map((b) => b.slug);

describe('built-in crew is data', () => {
  test('six seeded rows, no owner, active, every soul carries the money rule', async () => {
    const rows = await t.engine.repos.bots.activeFor(u.userId);
    const builtIns = rows.filter((b) => b.builtIn);
    expect(builtIns.map((b) => b.slug).sort()).toEqual([
      'errand',
      'finance',
      'guard',
      'invest',
      'mail',
      'penny',
    ]);
    for (const b of builtIns) {
      expect(b.userId).toBeNull();
      expect(b.soulMd).toContain('Mood never overrides money rules.');
    }
  });
  test('seeding is idempotent', async () => {
    await t.engine.services.bots.seedBuiltIns('/nonexistent');
    const rows = await t.db.db.execute(
      sql`select count(*)::int as n from bots where user_id is null`,
    );
    expect(JSON.stringify(rows)).toContain('"n":6');
  });
  test('every seeded tool exists in the registry', () => {
    const r = createRegistry();
    for (const b of BUILT_IN_BOTS) for (const id of b.toolIds) expect(r.get(id)).toBeDefined();
  });
});

describe('tool registry enforcement', () => {
  const r = createRegistry();
  const row = (over: Partial<BotRow>): BotRow =>
    ({
      id: 'bot_x',
      userId: 'usr_x',
      slug: 'x',
      name: 'X',
      soulMd: soul,
      mood: 'idle',
      toolIds: [],
      permissions: { canMoveMoney: false },
      nearSubAccount: null,
      status: 'active',
      builtIn: false,
      approvalId: null,
      createdAt: new Date(),
      ...over,
    }) as BotRow;
  test('every tool declares a risk level', () => {
    for (const tool of r.list()) expect(['read', 'write', 'money']).toContain(tool.risk);
  });
  test('custom bots never get money tools without caps, even if the row lists them', () => {
    const ids = r.allowedFor(row({ toolIds: ['propose_send', 'read_x'] })).map((x) => x.id);
    expect(ids).toEqual(['read_x']);
    const half = r.allowedFor(
      row({ toolIds: ['propose_send'], permissions: { canMoveMoney: true, perTxCap: '5' } }),
    );
    expect(half).toEqual([]);
    const capped = r.allowedFor(
      row({
        toolIds: ['propose_send'],
        permissions: { canMoveMoney: true, perTxCap: '5', dailyCap: '10' },
      }),
    );
    expect(capped.map((x) => x.id)).toEqual(['propose_send']);
  });
  test('builtInOnly tools are never exposed to custom bots; unknown ids dropped', () => {
    expect(r.allowedFor(row({ toolIds: ['draft_bot', 'confirm_bot', 'nope'] }))).toEqual([]);
    expect(r.allowedFor(row({ builtIn: true, toolIds: ['draft_bot'] })).map((x) => x.id)).toEqual([
      'draft_bot',
    ]);
  });
});

describe('create_bot: read-only -> plain confirm', () => {
  test('draft is pending_confirm and NOT routable until the user says yes', async () => {
    const r = await t.engine.services.bots.draft(u.userId, plan({}), u.space);
    expect(r).toMatchObject({ ok: true, status: 'pending_confirm', next: 'say_yes' });
    expect(await activeSlugs()).not.toContain('gh-buddy');
    expect(await t.engine.services.bots.confirm(u.userId, 'gh-buddy')).toEqual({ ok: true });
    expect(await activeSlugs()).toContain('gh-buddy');
    expect(await t.engine.services.bots.confirm(u.userId, 'gh-buddy')).toMatchObject({ ok: false });
  });
  test('another user cannot confirm or see my bot', async () => {
    const other = await enrolledUser(t, '+15550300');
    await t.engine.services.bots.draft(u.userId, plan({ slug: 'mine-only' }), u.space);
    expect(await t.engine.services.bots.confirm(other.userId, 'mine-only')).toMatchObject({
      ok: false,
    });
    expect((await t.engine.repos.bots.activeFor(other.userId)).map((b) => b.slug)).not.toContain(
      'gh-buddy',
    );
  });
  test('soul gets the money rule appended', async () => {
    await t.engine.services.bots.draft(u.userId, plan({ slug: 'reader-2' }), u.space);
    const b = await t.engine.repos.bots.byOwnerSlug(u.userId, 'reader-2');
    expect(b?.soulMd).toContain('Mood never overrides money rules.');
  });
});

describe('create_bot: write tools -> Guard + Face ID card', () => {
  test('X manager needs Face ID; plain confirm refused; signed approval activates it', async () => {
    const cardsBefore = t.messaging.cards.length;
    const r = await t.engine.services.bots.draft(
      u.userId,
      plan({ slug: 'x-manager', name: 'X Manager', toolIds: ['read_x', 'post_x'] }),
      u.space,
    );
    expect(r).toMatchObject({ ok: true, status: 'pending_approval', next: 'face_id_card_sent' });
    if (!r.ok || r.status !== 'pending_approval') throw new Error('unreachable');
    expect(t.messaging.cards.length).toBe(cardsBefore + 1);
    expect(await t.engine.services.bots.confirm(u.userId, 'x-manager')).toMatchObject({
      ok: false,
    });
    expect(await activeSlugs()).not.toContain('x-manager');

    const card = t.messaging.cards.at(-1)?.card;
    const token = card?.url.split('#t=')[1] ?? '';
    const appr = await t.engine.app.request(`/v1/approvals/${r.approvalId}`, {
      headers: { authorization: `Card ${token}` },
    });
    const a = (await appr.json()) as Approval;
    expect(a.kind).toBe('create_bot');
    expect(a.actions).toEqual([]);

    const submit = (body: unknown) =>
      t.engine.app.request(`/v1/approvals/${r.approvalId}/submit`, {
        method: 'POST',
        headers: {
          authorization: `Card ${token}`,
          'idempotency-key': idemKey(),
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    // delegate-action body is wrong for bot approvals
    expect((await submit({ signedDelegateAction: 'AAAAAAAA' })).status).toBe(400);
    // signature from some other key
    const { deviceKeys } = await import('./helpers.ts');
    const rogue = deviceKeys().sign(planApprovalMessage(r.approvalId, a.planHash));
    expect((await submit({ planSignature: rogue })).status).toBe(422);
    expect(await activeSlugs()).not.toContain('x-manager');
    // the enrolled device signs
    const good = u.keys.sign(planApprovalMessage(r.approvalId, a.planHash));
    const ok = await submit({ planSignature: good });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ status: 'settled' });
    expect(await activeSlugs()).toContain('x-manager');
    const events = await t.engine.repos.approvals.events(r.approvalId);
    expect(events.map((e) => e.toStatus)).toEqual(['pending', 'signed', 'settled']);
  });

  test('declining the card archives the bot', async () => {
    const r = await t.engine.services.bots.draft(
      u.userId,
      plan({ slug: 'gh-commenter', toolIds: ['github_comment'] }),
      u.space,
    );
    if (!r.ok || r.status !== 'pending_approval') throw new Error('expected approval');
    const token = t.messaging.cards.at(-1)?.card.url.split('#t=')[1] ?? '';
    const res = await t.engine.app.request(`/v1/approvals/${r.approvalId}/decline`, {
      method: 'POST',
      headers: {
        authorization: `Card ${token}`,
        'idempotency-key': idemKey(),
        'content-type': 'application/json',
      },
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect((await t.engine.repos.bots.byOwnerSlug(u.userId, 'gh-commenter'))?.status).toBe(
      'archived',
    );
  });
});

describe('create_bot: money tools', () => {
  test('without a cap: blocked by Guard, no row, no card', async () => {
    const cards = t.messaging.cards.length;
    const r = await t.engine.services.bots.draft(
      u.userId,
      plan({ slug: 'spender', toolIds: ['propose_send'] }),
      u.space,
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.reasons[0]).toContain('never get money tools unless you give them a spending cap');
    expect(await t.engine.repos.bots.byOwnerSlug(u.userId, 'spender')).toBeNull();
    expect(t.messaging.cards.length).toBe(cards);
  });
  test('with a user-granted cap: Face ID card; once live, Guard enforces the bot cap', async () => {
    const r = await t.engine.services.bots.draft(
      u.userId,
      plan({
        slug: 'tipper',
        toolIds: ['propose_send'],
        permissions: { canMoveMoney: true, perTxCap: '2', dailyCap: '5' },
      }),
      u.space,
    );
    if (!r.ok || r.status !== 'pending_approval') throw new Error('expected approval');
    await t.engine.services.bots.onApprovalSettled(r.approvalId);
    const bot = await t.engine.repos.bots.byOwnerSlug(u.userId, 'tipper');
    expect(bot?.status).toBe('active');
    if (!bot) throw new Error('no bot');
    await t.db.db.execute(
      sql`update guard_policies set allowlist = '{ada.penny.near}' where user_id = ${u.userId}`,
    );
    const over = await t.engine.services.approvals.createMoneyApproval({
      userId: u.userId,
      bot,
      plan: { kind: 'send', asset: 'USDC', amount: '3', to: 'ada.penny.near' },
      space: u.space,
    });
    expect(over.decision).toBe('block');
    expect(over.reasons.join(' ')).toContain("tipper's $2.00 per-payment cap");
    const under = await t.engine.services.approvals.createMoneyApproval({
      userId: u.userId,
      bot,
      plan: { kind: 'send', asset: 'USDC', amount: '2', to: 'ada.penny.near' },
      space: u.space,
    });
    expect(under.decision).toBe('allow_with_approval');
  });
  test('slug collisions with built-ins are blocked', async () => {
    const r = await t.engine.services.bots.draft(u.userId, plan({ slug: 'guard' }), u.space);
    expect(r.ok).toBe(false);
  });
});

describe('router (mocked model) picks among the user’s ACTIVE bots', () => {
  test('routes to invest and runs invest’s soul', async () => {
    const router = scriptedModel([
      { tool: 'route', input: { bot: 'invest', reason: 'portfolio q' } },
    ]);
    const chat = scriptedModel([{ text: 'eth momentum is up 4% this week' }]);
    t.setModels(router, chat);
    const r = await t.engine.services.crew.handle(u.userId, u.space, 'how is my portfolio?');
    expect(r.botSlug).toBe('invest');
    expect(r.text).toBe('eth momentum is up 4% this week');
  });
  test('can route to a user-created bot', async () => {
    t.setModels(
      scriptedModel([{ tool: 'route', input: { bot: 'gh-buddy', reason: 'github' } }]),
      scriptedModel([{ text: '3 new PRs' }]),
    );
    const r = await t.engine.services.crew.handle(u.userId, u.space, 'anything new on github?');
    expect(r.botSlug).toBe('gh-buddy');
  });
  test('unknown or inactive slug falls back to penny', async () => {
    t.setModels(
      scriptedModel([{ tool: 'route', input: { bot: 'spender', reason: 'x' } }]),
      scriptedModel([{ text: 'hi' }]),
    );
    expect((await t.engine.services.crew.handle(u.userId, u.space, 'yo')).botSlug).toBe('penny');
  });
  test('router failure falls back to penny', async () => {
    const broken = scriptedModel([{ text: '' }]);
    (broken as unknown as { doGenerate: () => Promise<never> }).doGenerate = async () => {
      throw new Error('boom');
    };
    t.setModels(broken, scriptedModel([{ text: 'still here' }]));
    const r = await t.engine.services.crew.handle(u.userId, u.space, 'yo');
    expect(r.botSlug).toBe('penny');
    expect(r.text).toBe('still here');
  });
  test('penny drafts a bot through the draft_bot tool (typed plan only)', async () => {
    t.setModels(
      scriptedModel([{ tool: 'route', input: { bot: 'penny', reason: 'new bot' } }]),
      scriptedModel([
        {
          tool: 'draft_bot',
          input: {
            kind: 'create_bot',
            slug: 'news-bot',
            name: 'News',
            soulMd: soul,
            toolIds: ['read_x'],
            permissions: { canMoveMoney: false },
          },
        },
        { text: 'drafted News. say yes and it goes live.' },
      ]),
    );
    const r = await t.engine.services.crew.handle(
      u.userId,
      u.space,
      'make me a bot that reads crypto news on X',
    );
    expect(r.toolCalls).toContain('draft_bot');
    expect((await t.engine.repos.bots.byOwnerSlug(u.userId, 'news-bot'))?.status).toBe(
      'pending_confirm',
    );
  });
  test('a custom bot cannot call draft_bot or money tools even if the model tries', async () => {
    t.setModels(
      scriptedModel([{ tool: 'route', input: { bot: 'gh-buddy', reason: 'x' } }]),
      scriptedModel([
        {
          tool: 'propose_send',
          input: { kind: 'send', asset: 'USDC', amount: '1', to: 'evil.near' },
        },
        { text: 'done' },
      ]),
    );
    const before = t.messaging.cards.length;
    const r = await t.engine.services.crew.handle(u.userId, u.space, 'send 1 usdc to evil.near');
    expect(r.botSlug).toBe('gh-buddy');
    expect(t.messaging.cards.length).toBe(before);
  });
});
