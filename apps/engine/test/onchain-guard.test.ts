import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { GuardPolicyView } from '@penny/chain';
import type { MoneyPlan } from '@penny/shared';
import { sql } from 'drizzle-orm';
import {
  evaluateOnChainGuard,
  guardAgentId,
  type OnChainPolicyView,
} from '../src/guard/onchain.ts';
import { FakeGuard } from '../src/ports/chain.ts';
import { enrolledUser, idemKey, makeEngine, signBody, type TestEngine } from './helpers.ts';

const TOKEN = 'tusd.penny.testnet';
const now = new Date('2026-11-05T19:00:00Z');

const view = (over: Partial<GuardPolicyView> = {}): GuardPolicyView => ({
  owner_id: 'ada.penny.near',
  agent_id: 'invest.penny.near',
  limits: [{ token: TOKEN, per_tx_cap: '25000000', daily_cap: '50000000' }],
  allowlist: [],
  expires_at: null,
  paused: false,
  revoked: false,
  last_nonce: '0',
  ...over,
});

const onChain = (over: Partial<Parameters<typeof evaluateOnChainGuard>[0]> = {}) => {
  const plan: MoneyPlan = { kind: 'send', asset: 'USDC', amount: '10', to: 'ada.penny.near' };
  return evaluateOnChainGuard({
    now,
    contractId: 'guard.penny.testnet',
    agentAccountId: 'invest.penny.near',
    agentName: 'Invest',
    token: TOKEN,
    pausedAll: false,
    policy: view() as OnChainPolicyView,
    spentToday: '0',
    plan,
    ...over,
  });
};

describe('on-chain guard (pure)', () => {
  test('allows a policy that covers the move', () => {
    expect(onChain()).toEqual([]);
  });
  test('paused-all blocks before anything else', () => {
    expect(onChain({ pausedAll: true, policy: null }).join(' ')).toContain('paused');
  });
  test('no policy, revoked, paused and expired each block', () => {
    expect(onChain({ policy: null }).join(' ')).toContain('no allowance');
    expect(onChain({ policy: view({ revoked: true }) }).join(' ')).toContain('revoked');
    expect(onChain({ policy: view({ paused: true }) }).join(' ')).toContain('paused');
    const expired = view({ expires_at: (BigInt(now.getTime()) * 1_000_000n).toString() });
    expect(onChain({ policy: expired }).join(' ')).toContain('ran out');
  });
  test('a future expiry passes', () => {
    const future = view({ expires_at: (BigInt(now.getTime() + 60_000) * 1_000_000n).toString() });
    expect(onChain({ policy: future })).toEqual([]);
  });
  test('NEAR sends cannot be sized against token caps', () => {
    const near: MoneyPlan = { kind: 'send', asset: 'NEAR', amount: '1', to: 'ada.penny.near' };
    expect(onChain({ plan: near }).join(' ')).toContain('dollar payments');
  });
  test('missing token allowance blocks', () => {
    const p = view({ limits: [{ token: 'usdc.near', per_tx_cap: '1', daily_cap: '1' }] });
    expect(onChain({ policy: p }).join(' ')).toContain("doesn't allow");
  });
  test('per-payment and daily caps use the token base units', () => {
    const tight = view({
      limits: [{ token: TOKEN, per_tx_cap: '5000000', daily_cap: '50000000' }],
    });
    expect(onChain({ policy: tight }).join(' ')).toContain('per-payment');
    expect(onChain({ spentToday: '45000000' }).join(' ')).toContain('daily');
    expect(onChain({ spentToday: '40000000' })).toEqual([]);
  });
  test('allowlist applies to a direct recipient, not the guard or the agent', () => {
    const listed = view({ allowlist: ['mum.near'] });
    expect(onChain({ policy: listed }).join(' ')).toContain("isn't on the list");
    const plan: MoneyPlan = { kind: 'send', asset: 'USDC', amount: '10', to: 'mum.near' };
    expect(onChain({ policy: listed, plan })).toEqual([]);
    expect(onChain({ policy: listed, plan }).length).toBe(0);
    const toGuard: MoneyPlan = {
      kind: 'send',
      asset: 'USDC',
      amount: '10',
      to: 'guard.penny.testnet',
    };
    expect(onChain({ policy: listed, plan: toGuard }).join(' ')).toContain("isn't one");
    const toAgent: MoneyPlan = {
      kind: 'send',
      asset: 'USDC',
      amount: '10',
      to: 'invest.penny.near',
    };
    // paying the contract or the agent is refused even with no allowlist
    expect(onChain({ plan: toAgent }).join(' ')).toContain("isn't one");
  });
  test('unreadable amounts block instead of passing', () => {
    expect(onChain({ spentToday: 'not-a-number' }).join(' ')).toContain("couldn't check");
    const badCap = view({ limits: [{ token: TOKEN, per_tx_cap: 'x', daily_cap: '1' }] });
    expect(onChain({ policy: badCap }).join(' ')).toContain("couldn't check");
  });
  test('agent id is the bot sub-account, or the app account for Penny', () => {
    expect(guardAgentId('invest', 'penny.near')).toBe('invest.penny.near');
    expect(guardAgentId('penny', 'penny.near')).toBe('penny.near');
    expect(guardAgentId(null, 'penny.near')).toBe('penny.near');
    expect(guardAgentId('Invest', 'penny.near')).toBeNull();
    expect(guardAgentId('a'.repeat(64), 'penny.near')).toBeNull();
  });
});

describe('spend path checks the shared Guard contract', () => {
  let t: TestEngine;
  let u: Awaited<ReturnType<typeof enrolledUser>>;
  let guard: FakeGuard;

  beforeAll(async () => {
    t = await makeEngine();
    u = await enrolledUser(t);
    await t.db.db.execute(
      sql`update guard_policies set daily_usd = '100000', max_approvals_per_10_min = 100000 where user_id = ${u.userId}`,
    );
    guard = new FakeGuard();
    guard.tokens = [TOKEN];
    guard.setPolicy(
      u.accountId,
      'penny.near',
      view({ owner_id: u.accountId, agent_id: 'penny.near' }),
    );
    t.chain.guard = guard;
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
    return t.engine.services.approvals.createMoneyApproval({
      userId: u.userId,
      bot: null,
      plan,
      space: u.space,
    });
  }

  const req = (path: string, init: RequestInit & { token?: string; idem?: string } = {}) => {
    const headers = new Headers(init.headers);
    if (init.token) headers.set('authorization', `Card ${init.token}`);
    if (init.idem) headers.set('idempotency-key', init.idem);
    if (init.body) headers.set('content-type', 'application/json');
    return t.engine.app.request(path, { ...init, headers });
  };

  test('an allowed move still gets a card', async () => {
    const r = await create();
    expect(r.decision).toBe('allow_with_approval');
  });

  test('no on-chain allowance blocks before a card', async () => {
    guard.setPolicy(u.accountId, 'penny.near', null);
    const before = t.messaging.cards.length;
    const r = await create();
    expect(r.decision).toBe('block');
    expect(r.reasons.join(' ')).toContain('no allowance');
    expect(t.messaging.cards.length).toBe(before + 1); // blocked card only
    expect(t.messaging.cards.at(-1)?.card.caption).toContain('Not today');
    guard.setPolicy(
      u.accountId,
      'penny.near',
      view({ owner_id: u.accountId, agent_id: 'penny.near' }),
    );
  });

  test('paused-all, over-cap and allowlist blocks create no approval', async () => {
    const cases: { setup: () => void; plan: MoneyPlan; reason: string }[] = [
      {
        setup: () => {
          guard.pausedAll = true;
        },
        plan: send('10'),
        reason: 'paused',
      },
      {
        setup: () => {
          guard.pausedAll = false;
          guard.setPolicy(
            u.accountId,
            'penny.near',
            view({
              owner_id: u.accountId,
              agent_id: 'penny.near',
              limits: [{ token: TOKEN, per_tx_cap: '5000000', daily_cap: '50000000' }],
            }),
          );
        },
        plan: send('10'),
        reason: 'per-payment',
      },
      {
        setup: () => {
          guard.setPolicy(
            u.accountId,
            'penny.near',
            view({ owner_id: u.accountId, agent_id: 'penny.near', allowlist: ['mum.near'] }),
          );
        },
        plan: send('10', 'ada.penny.near'),
        reason: "isn't on the list",
      },
    ];
    for (const c of cases) {
      c.setup();
      const before = (await t.engine.repos.approvals.listForUser(u.userId, 50)).length;
      const r = await create(c.plan);
      expect(r.decision).toBe('block');
      expect(r.reasons.join(' ')).toContain(c.reason);
      expect((await t.engine.repos.approvals.listForUser(u.userId, 50)).length).toBe(before);
    }
    guard.pausedAll = false;
    guard.setPolicy(
      u.accountId,
      'penny.near',
      view({ owner_id: u.accountId, agent_id: 'penny.near' }),
    );
  });

  test('an RPC failure fails closed, with no technical detail in the reply', async () => {
    guard.fail = 'getPolicy';
    const r = await create();
    expect(r.decision).toBe('block');
    expect(r.reasons.join(' ')).toContain("couldn't check");
    expect(r.reasons.join(' ')).not.toContain('getPolicy');
    guard.fail = null;
  });

  test('an unreadable policy or token list fails closed', async () => {
    guard.setPolicy(u.accountId, 'penny.near', { nope: true } as unknown as GuardPolicyView);
    expect((await create()).decision).toBe('block');
    guard.setPolicy(
      u.accountId,
      'penny.near',
      view({ owner_id: u.accountId, agent_id: 'penny.near' }),
    );
    guard.tokens = [TOKEN, 'second.near'];
    expect((await create()).decision).toBe('block');
    guard.tokens = [TOKEN];
  });

  test('a NEAR send is blocked while the shared Guard is on', async () => {
    const near: MoneyPlan = { kind: 'send', asset: 'NEAR', amount: '0.1', to: 'ada.penny.near' };
    const r = await create(near);
    expect(r.decision).toBe('block');
    expect(r.reasons.join(' ')).toContain('dollar payments');
  });

  test('the relay re-check blocks a card whose allowance changed after it was sent', async () => {
    const r = await create(send('5'));
    if (r.decision !== 'allow_with_approval') throw new Error('expected a card');
    const relays = t.chain.relayCalls.length;
    guard.pausedAll = true;
    const res = await req(`/v1/approvals/${r.approvalId}/sign`, {
      method: 'POST',
      token: r.cardToken,
      idem: idemKey(),
      body: JSON.stringify(await signBody(t, r.cardToken, u)),
    });
    expect(res.status).toBe(409);
    expect(t.chain.relayCalls.length).toBe(relays);
    const row = await t.engine.repos.approvals.get(r.approvalId);
    expect(row?.status).toBe('cancelled');
    guard.pausedAll = false;
  });
});
