import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type Approval, type CreateBotPlan, planApprovalMessage } from '@penny/shared';
import { createRegistry } from '../src/brain/tools.ts';
import { FakeConnector, writeTargetProblem } from '../src/connectors/composio.ts';
import { toolkitsForBot, toolkitsForTools } from '../src/connectors/toolkits.ts';
import type { BotRow } from '../src/repo/bots.ts';
import {
  enrolledUser,
  idemKey,
  makeEngine,
  signBody,
  type TestEngine,
  tokenFromUrl,
} from './helpers.ts';

let t: TestEngine;
let connector: FakeConnector;
let u: Awaited<ReturnType<typeof enrolledUser>>;

beforeAll(async () => {
  connector = new FakeConnector();
  t = await makeEngine({ connectors: connector });
  u = await enrolledUser(t, '+15550210');
}, 120_000);
afterAll(async () => {
  await t?.db.close();
});

const soul = '# Scout\nI watch one repo, quietly, and tell you what changed in it.';
const plan = (over: Partial<CreateBotPlan> = {}): CreateBotPlan => ({
  kind: 'create_bot',
  slug: 'scout',
  name: 'Scout',
  soulMd: soul,
  toolIds: ['read_github'],
  permissions: { canMoveMoney: false },
  ...over,
});

/** Make a read-only bot and turn it on with a plain yes. */
async function activeBot(over: Partial<CreateBotPlan> = {}): Promise<BotRow> {
  const draft = await t.engine.services.bots.draft(u.userId, plan(over), u.space);
  if (!draft.ok) throw new Error(draft.reasons.join(' '));
  if (draft.status === 'pending_confirm') {
    const r = await t.engine.services.bots.confirm(u.userId, draft.slug);
    if (!r.ok) throw new Error(r.reason ?? 'confirm failed');
  }
  const row = await t.engine.repos.bots.byOwnerSlug(u.userId, draft.slug);
  if (!row) throw new Error('bot missing');
  return row;
}

const sign = (id: string, token: string, body: unknown) =>
  t.engine.app.request(`/v1/approvals/${id}/sign`, {
    method: 'POST',
    headers: {
      authorization: `Card ${token}`,
      'idempotency-key': idemKey(),
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });

describe('a bot\u2019s grants decide which apps it gets', () => {
  test('capability tools name the toolkit they unlock, and nothing else does', () => {
    expect(toolkitsForTools(['read_github'])).toEqual(['github']);
    expect(toolkitsForTools(['read_github', 'github_comment'])).toEqual(['github']);
    expect(toolkitsForTools(['read_x', 'post_x'])).toEqual(['twitter']);
    expect(toolkitsForTools(['read_x', 'read_github', 'get_balances'])).toEqual([
      'github',
      'twitter',
    ]);
    expect(toolkitsForTools(['get_balances', 'remember'])).toEqual([]);
  });

  test('a custom bot with no app grants gets no connector tools', () => {
    expect(toolkitsForBot('note-taker', ['remember', 'recall'])).toEqual([]);
    expect(toolkitsForBot('note-taker', [])).toEqual([]);
  });

  test('built-ins keep their fixed apps, and their no-app members stay empty', () => {
    expect(toolkitsForBot('mail')).toEqual(['gmail']);
    expect(toolkitsForBot('penny')).toEqual(['gmail', 'github']);
    expect(toolkitsForBot('invest')).toBeNull();
    // A grant list never widens a built-in: its apps are part of the product.
    expect(toolkitsForBot('invest', ['post_x'])).toBeNull();
  });

  test('the four connector tools are grants, not callables', () => {
    const r = createRegistry();
    for (const id of ['read_github', 'read_x', 'post_x', 'github_comment'])
      expect(r.get(id)?.capability).toBe(true);
    const bot = { toolIds: ['read_github', 'post_x', 'request_access', 'remember'] } as BotRow;
    const tools = r.toAiTools({ bot } as never);
    expect(tools.read_github).toBeUndefined();
    expect(tools.post_x).toBeUndefined();
    expect(tools.request_access).toBeDefined();
    expect(tools.remember).toBeDefined();
  });
});

describe('a bot asks for a tool it needs', () => {
  test('the ask sends a Face ID card and grants nothing yet', async () => {
    const bot = await activeBot();
    expect(bot.toolIds).toContain('request_access');
    // Making a bot never grants apps beyond what the plan named.
    expect(bot.toolIds).toEqual(['read_github', 'request_access']);
    const cards = t.messaging.cards.length;

    const r = await t.engine.services.bots.requestTool(
      u.userId,
      bot,
      'read_x',
      'to see what people are saying about the repo',
      u.space,
    );
    expect(r).toMatchObject({ ok: true, status: 'pending_approval' });
    expect(t.messaging.cards.length).toBe(cards + 1);
    const again = await t.engine.repos.bots.byId(bot.id);
    expect(again?.toolIds).not.toContain('read_x');
  });

  test('signing the card adds the tool once, and the app loads from then on', async () => {
    const bot = await activeBot({ slug: 'scout-2', name: 'Scout Two' });
    const r = await t.engine.services.bots.requestTool(
      u.userId,
      bot,
      'read_x',
      'to read mentions',
      u.space,
    );
    if (!r.ok || !r.approvalId) throw new Error('no card');
    const token = tokenFromUrl(t.messaging.cards.at(-1)?.card.url);
    const view = (await (
      await t.engine.app.request(`/v1/approvals/${r.approvalId}`, {
        headers: { authorization: `Card ${token}` },
      })
    ).json()) as Approval;
    expect(view.kind).toBe('grant_bot');
    expect(view.actions).toEqual([]);
    expect(view.facts.map((f) => f.label)).toContain('Tool');

    const body = await signBody(t, token, u, {
      planSignature: u.keys.sign(planApprovalMessage(r.approvalId, view.planHash)),
    });
    const signed = await sign(r.approvalId, token, body);
    expect(signed.status).toBe(200);
    expect(((await signed.json()) as { status: string }).status).toBe('settled');

    const after = await t.engine.repos.bots.byId(bot.id);
    expect(after?.toolIds).toContain('read_x');
    expect(after?.toolIds.filter((id) => id === 'read_x')).toHaveLength(1);

    // The grant is what loads X: the connector is asked for the bot's grants.
    await connector.toolsFor(u.userId, after?.slug ?? '', {
      slug: after?.slug ?? '',
      toolIds: after?.toolIds ?? [],
    });
    expect(connector.toolkits).toEqual(['github', 'twitter']);

    // A settled card cannot be signed again.
    expect((await sign(r.approvalId, token, body)).status).toBe(409);
  });

  test('a second request for a tool it already has is refused', async () => {
    const bot = await activeBot({ slug: 'scout-3', name: 'Scout Three' });
    const r = await t.engine.services.bots.requestTool(
      u.userId,
      bot,
      'read_github',
      'again',
      u.space,
    );
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.reason).toBe('this bot already has that tool');
  });

  test('money tools, unknown tools and core plumbing are refused', async () => {
    const bot = await activeBot({ slug: 'scout-4', name: 'Scout Four' });
    const money = await t.engine.services.bots.requestTool(
      u.userId,
      bot,
      'propose_send',
      'to move money',
      u.space,
    );
    expect(money.ok).toBe(false);
    if (!money.ok) expect(money.reason).toContain('money tools');

    const unknown = await t.engine.services.bots.requestTool(
      u.userId,
      bot,
      'read_notion',
      'to read pages',
      u.space,
    );
    expect(unknown.ok).toBe(false);

    const plumbing = await t.engine.services.bots.requestTool(
      u.userId,
      bot,
      'draft_bot',
      'to make bots',
      u.space,
    );
    expect(plumbing.ok).toBe(false);
    if (!plumbing.ok) expect(plumbing.reason).toContain('reserved for the core crew');
  });

  test('a built-in crew member cannot ask for tools', async () => {
    const penny = await t.engine.repos.bots.builtIn('penny');
    if (!penny) throw new Error('penny missing');
    const r = await t.engine.services.bots.requestTool(
      u.userId,
      penny,
      'read_x',
      'to read X',
      u.space,
    );
    expect(r).toMatchObject({ ok: false });
    if (!r.ok) expect(r.reason).toContain('built-in crew');
  });

  test('an expired grant card is not renewed behind the user', async () => {
    const bot = await activeBot({ slug: 'scout-5', name: 'Scout Five' });
    const r = await t.engine.services.bots.requestTool(
      u.userId,
      bot,
      'read_x',
      'to read mentions',
      u.space,
    );
    if (!r.ok || !r.approvalId) throw new Error('no card');
    const token = tokenFromUrl(t.messaging.cards.at(-1)?.card.url);
    const row = await t.engine.repos.approvals.get(r.approvalId);
    if (!row) throw new Error('no row');
    t.clock.now = new Date(row.expiresAt.getTime() + 60_000);
    const renewed = await t.engine.services.approvals.renewByToken(token);
    expect(renewed.approvalId).toBeNull();
    const after = await t.engine.repos.bots.byId(bot.id);
    expect(after?.toolIds).not.toContain('read_x');
    t.clock.now = new Date('2026-11-05T19:00:00Z');
  });

  test('appending a tool twice keeps exactly one copy', async () => {
    const bot = await activeBot({ slug: 'scout-6', name: 'Scout Six' });
    const first = await t.engine.repos.bots.addTool(bot.id, 'read_x');
    const second = await t.engine.repos.bots.addTool(bot.id, 'read_x');
    expect(first?.toolIds.filter((id) => id === 'read_x')).toHaveLength(1);
    expect(second?.toolIds.filter((id) => id === 'read_x')).toHaveLength(1);
  });

  test('a write grant is what lets an X write be approved, and only then', () => {
    // The card-time and execution-time checks both read the same grant list.
    // Reading X already loads the toolkit, so the refusal comes from a bot that
    // holds no app grant at all, not from a read-only one.
    expect(writeTargetProblem('twitter', 'TWITTER_CREATION_OF_A_POST', 'poster', [])).toBe(
      'twitter is not enabled for this bot',
    );
    expect(
      writeTargetProblem('twitter', 'TWITTER_CREATION_OF_A_POST', 'poster', ['read_github']),
    ).toBe('twitter is not enabled for this bot');
    expect(
      writeTargetProblem('twitter', 'TWITTER_CREATION_OF_A_POST', 'poster', ['read_x']),
    ).toBeNull();
    expect(
      writeTargetProblem('twitter', 'TWITTER_CREATION_OF_A_POST', 'poster', ['read_x', 'post_x']),
    ).toBeNull();
  });
});
