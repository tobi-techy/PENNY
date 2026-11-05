import { describe, expect, test } from 'bun:test';
import type { CreateBotPlan, MoneyPlan } from '@penny/shared';
import { evaluateBotCreation, maxRisk, type ToolInfo } from '../src/guard/bot-policy.ts';
import { DEFAULT_POLICY, evaluate, type GuardContext } from '../src/guard/policy.ts';

const now = new Date('2026-11-05T19:00:00Z');
const ctx = (over: Partial<GuardContext> = {}): GuardContext => ({
  now,
  spentLast24hMicros: 0n,
  knownRecipients: new Set(['ada.penny.near']),
  approvalsLast10Min: 0,
  ...over,
});
const send = (
  amount: string,
  to = 'ada.penny.near',
  asset: 'USDC' | 'NEAR' = 'USDC',
): MoneyPlan => ({
  kind: 'send',
  asset,
  amount,
  to,
});
const invest = (amountUsd: string): MoneyPlan => ({
  kind: 'invest',
  fromAsset: 'USDC',
  amountUsd,
  portfolioId: 'eth-momentum',
  quoteId: 'q1',
});

describe('per-tx cap', () => {
  test('at the cap is allowed, a micro over is blocked', () => {
    expect(evaluate(send('50'), DEFAULT_POLICY, ctx()).decision).toBe('allow_with_approval');
    const r = evaluate(send('50.000001'), DEFAULT_POLICY, ctx());
    expect(r.decision).toBe('block');
    expect(r.reasons.join(' ')).toContain('per-payment limit');
  });
  test('zero amount is blocked', () => {
    expect(evaluate(send('0'), DEFAULT_POLICY, ctx()).decision).toBe('block');
  });
});

describe('daily cap (rolling 24h)', () => {
  test('blocks when ledger + amount exceeds daily', () => {
    const r = evaluate(send('30'), DEFAULT_POLICY, ctx({ spentLast24hMicros: 80_000_000n }));
    expect(r.decision).toBe('block');
    expect(r.reasons.join(' ')).toContain('$20.00 left');
  });
  test('exactly reaching daily is fine and reports remaining', () => {
    const r = evaluate(send('20'), DEFAULT_POLICY, ctx({ spentLast24hMicros: 80_000_000n }));
    expect(r.decision).toBe('allow_with_approval');
    expect(r.reasons.join(' ')).toContain('$0.00 of $100.00 left');
  });
  test('over-spent ledger never reports negative remaining', () => {
    const r = evaluate(send('1'), DEFAULT_POLICY, ctx({ spentLast24hMicros: 150_000_000n }));
    expect(r.reasons.join(' ')).toContain('$0.00 left');
  });
});

describe('recipients', () => {
  test('new recipient over threshold is blocked', () => {
    const r = evaluate(send('25', 'stranger.near'), DEFAULT_POLICY, ctx());
    expect(r.decision).toBe('block');
    expect(r.reasons.join(' ')).toContain('never paid stranger.near');
  });
  test('new recipient under threshold is allowed with a note', () => {
    const r = evaluate(send('5', 'stranger.near'), DEFAULT_POLICY, ctx());
    expect(r.decision).toBe('allow_with_approval');
    expect(r.reasons[0]).toContain('First time paying');
  });
  test('allowlisted recipient skips the new-recipient rule', () => {
    const policy = { ...DEFAULT_POLICY, allowlist: ['mum.near'] };
    expect(evaluate(send('45', 'mum.near'), policy, ctx()).decision).toBe('allow_with_approval');
  });
});

describe('assets and prices', () => {
  test('asset whitelist enforced', () => {
    const r = evaluate(send('1'), DEFAULT_POLICY, ctx({ assetWhitelist: ['NEAR'] }));
    expect(r.decision).toBe('block');
  });
  test('NEAR send without a price needs more info', () => {
    expect(evaluate(send('1', 'ada.penny.near', 'NEAR'), DEFAULT_POLICY, ctx()).decision).toBe(
      'needs_more_info',
    );
  });
  test('NEAR is converted with bigint and rounded up', () => {
    // 10 NEAR at $5.123456 = $51.23456 > $50 cap
    const r = evaluate(
      send('10', 'ada.penny.near', 'NEAR'),
      DEFAULT_POLICY,
      ctx({ nearUsdPriceMicros: 5_123_456n }),
    );
    expect(r.decision).toBe('block');
    expect(r.amountMicrosUsd).toBe(51_234_560n);
    const tiny = evaluate(
      send('0.000001', 'ada.penny.near', 'NEAR'),
      DEFAULT_POLICY,
      ctx({ nearUsdPriceMicros: 1n }),
    );
    expect(tiny.amountMicrosUsd).toBe(1n); // rounds up, never to zero
  });
});

describe('quote freshness', () => {
  const q = (ms: number) => ({ id: 'q1', expiresAt: new Date(now.getTime() + ms) });
  test('fresh quote allowed', () => {
    expect(evaluate(invest('10'), DEFAULT_POLICY, ctx({ quote: q(60_000) })).decision).toBe(
      'allow_with_approval',
    );
  });
  test('missing or mismatched quote needs more info', () => {
    expect(evaluate(invest('10'), DEFAULT_POLICY, ctx()).decision).toBe('needs_more_info');
    expect(
      evaluate(
        invest('10'),
        DEFAULT_POLICY,
        ctx({ quote: { id: 'other', expiresAt: q(60_000).expiresAt } }),
      ).decision,
    ).toBe('needs_more_info');
  });
  test('expired quote blocked, too-long quote blocked, nearly-expired refresh', () => {
    expect(evaluate(invest('10'), DEFAULT_POLICY, ctx({ quote: q(-1) })).decision).toBe('block');
    expect(evaluate(invest('10'), DEFAULT_POLICY, ctx({ quote: q(121_000) })).decision).toBe(
      'block',
    );
    expect(evaluate(invest('10'), DEFAULT_POLICY, ctx({ quote: q(5_000) })).decision).toBe(
      'needs_more_info',
    );
  });
});

describe('velocity', () => {
  test('blocks at max approvals per 10 minutes', () => {
    expect(evaluate(send('1'), DEFAULT_POLICY, ctx({ approvalsLast10Min: 4 })).decision).toBe(
      'allow_with_approval',
    );
    const r = evaluate(send('1'), DEFAULT_POLICY, ctx({ approvalsLast10Min: 5 }));
    expect(r.decision).toBe('block');
    expect(r.reasons.join(' ')).toContain('10 minutes');
  });
});

describe('bot caps', () => {
  test('bot without money permission is blocked', () => {
    const r = evaluate(
      send('1'),
      DEFAULT_POLICY,
      ctx({ bot: { botSlug: 'x-manager', canMoveMoney: false, spentLast24hMicros: 0n } }),
    );
    expect(r.decision).toBe('block');
    expect(r.reasons[0]).toContain("isn't allowed to move money");
  });
  test('bot caps enforced on top of user caps', () => {
    const bot = {
      botSlug: 'errand-2',
      canMoveMoney: true,
      perTxCap: '5',
      dailyCap: '10',
      spentLast24hMicros: 8_000_000n,
    };
    expect(evaluate(send('6'), DEFAULT_POLICY, ctx({ bot })).decision).toBe('block');
    expect(evaluate(send('3'), DEFAULT_POLICY, ctx({ bot })).decision).toBe('block');
    expect(evaluate(send('2'), DEFAULT_POLICY, ctx({ bot })).decision).toBe('allow_with_approval');
  });
  test('money permission without caps is blocked', () => {
    const r = evaluate(
      send('1'),
      DEFAULT_POLICY,
      ctx({ bot: { botSlug: 'b', canMoveMoney: true, spentLast24hMicros: 0n } }),
    );
    expect(r.decision).toBe('block');
  });
});

describe('multiple violations', () => {
  test('all reasons reported', () => {
    const r = evaluate(
      send('70', 'stranger.near'),
      DEFAULT_POLICY,
      ctx({ spentLast24hMicros: 90_000_000n, approvalsLast10Min: 9 }),
    );
    expect(r.decision).toBe('block');
    expect(r.reasons.length).toBe(4);
  });
});

// ---------- bot creation ----------

const tools = new Map<string, ToolInfo>([
  ['get_balances', { risk: 'read' }],
  ['read_github', { risk: 'read' }],
  ['post_x', { risk: 'write' }],
  ['propose_send', { risk: 'money' }],
  ['draft_bot', { risk: 'read', builtInOnly: true }],
]);
const botPlan = (over: Partial<CreateBotPlan> = {}): CreateBotPlan => ({
  kind: 'create_bot',
  slug: 'gh-buddy',
  name: 'GH Buddy',
  soulMd: '# GH Buddy\nI read your repos and tell you what changed.',
  toolIds: ['read_github'],
  permissions: { canMoveMoney: false },
  ...over,
});
const taken = new Set(['penny', 'invest', 'guard', 'mail', 'finance', 'errand']);

describe('evaluateBotCreation', () => {
  test('read-only bot -> plain confirm', () => {
    const r = evaluateBotCreation(botPlan(), tools, taken, DEFAULT_POLICY);
    expect(r).toMatchObject({
      decision: 'allow_with_approval',
      risk: 'read',
      confirmation: 'plain_confirm',
    });
  });
  test('write tool -> Face ID', () => {
    const r = evaluateBotCreation(
      botPlan({ toolIds: ['read_github', 'post_x'] }),
      tools,
      taken,
      DEFAULT_POLICY,
    );
    expect(r).toMatchObject({
      decision: 'allow_with_approval',
      risk: 'write',
      confirmation: 'face_id',
    });
  });
  test('money tool without a cap is blocked', () => {
    const r = evaluateBotCreation(
      botPlan({ toolIds: ['propose_send'] }),
      tools,
      taken,
      DEFAULT_POLICY,
    );
    expect(r.decision).toBe('block');
    expect(r.reasons[0]).toContain('never get money tools unless you give them a spending cap');
  });
  test('money tool with caps -> Face ID', () => {
    const r = evaluateBotCreation(
      botPlan({
        toolIds: ['propose_send'],
        permissions: { canMoveMoney: true, perTxCap: '5', dailyCap: '20' },
      }),
      tools,
      taken,
      DEFAULT_POLICY,
    );
    expect(r).toMatchObject({
      decision: 'allow_with_approval',
      risk: 'money',
      confirmation: 'face_id',
    });
  });
  test('bot caps above user caps are blocked', () => {
    const r = evaluateBotCreation(
      botPlan({
        toolIds: ['propose_send'],
        permissions: { canMoveMoney: true, perTxCap: '60', dailyCap: '500' },
      }),
      tools,
      taken,
      DEFAULT_POLICY,
    );
    expect(r.decision).toBe('block');
    expect(r.reasons.length).toBe(2);
  });
  test('perTx > daily blocked', () => {
    const r = evaluateBotCreation(
      botPlan({
        toolIds: ['propose_send'],
        permissions: { canMoveMoney: true, perTxCap: '10', dailyCap: '5' },
      }),
      tools,
      taken,
      DEFAULT_POLICY,
    );
    expect(r.decision).toBe('block');
  });
  test('money permissions on a bot without money tools are rejected', () => {
    const r = evaluateBotCreation(
      botPlan({ permissions: { canMoveMoney: true, perTxCap: '5', dailyCap: '5' } }),
      tools,
      taken,
      DEFAULT_POLICY,
    );
    expect(r.decision).toBe('block');
  });
  test('unknown, reserved and duplicate tools blocked; slug collisions blocked', () => {
    expect(
      evaluateBotCreation(botPlan({ toolIds: ['hack_bank'] }), tools, taken, DEFAULT_POLICY)
        .decision,
    ).toBe('block');
    expect(
      evaluateBotCreation(botPlan({ toolIds: ['draft_bot'] }), tools, taken, DEFAULT_POLICY)
        .decision,
    ).toBe('block');
    expect(
      evaluateBotCreation(
        botPlan({ toolIds: ['read_github', 'read_github'] }),
        tools,
        taken,
        DEFAULT_POLICY,
      ).decision,
    ).toBe('block');
    expect(
      evaluateBotCreation(botPlan({ slug: 'guard' }), tools, taken, DEFAULT_POLICY).decision,
    ).toBe('block');
  });
  test('maxRisk', () => {
    expect(maxRisk([])).toBe('read');
    expect(maxRisk(['read', 'money', 'write'])).toBe('money');
  });
});
