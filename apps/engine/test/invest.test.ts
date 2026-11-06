import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { NearAction } from '@penny/shared';
import { sql } from 'drizzle-orm';
import { type ApprovalError, investDepositAddress } from '../src/approvals/service.ts';
import { formatUnits, mapSwapStatus } from '../src/market/invest.ts';
import { enrolledUser, makeEngine, type TestEngine } from './helpers.ts';

let t: TestEngine;
let u: Awaited<ReturnType<typeof enrolledUser>>;
const SDA = { signedDelegateAction: 'AAAAAAAA' };

beforeAll(async () => {
  t = await makeEngine();
  u = await enrolledUser(t);
  await t.db.db.execute(
    sql`update guard_policies set daily_usd = '100000', max_approvals_per_10_min = 100000 where user_id = ${u.userId}`,
  );
}, 120_000);
afterAll(async () => {
  await t?.db.close();
});

async function invest(amountUsd = '10', asset = 'SOL') {
  const r = await t.engine.services.approvals.createInvestApproval({
    userId: u.userId,
    bot: null,
    asset,
    amountUsd,
    space: u.space,
  });
  if (r.decision !== 'allow_with_approval') throw new Error(`${r.decision}: ${r.reasons}`);
  return r;
}

async function submitErr(id: string, token: string): Promise<ApprovalError> {
  try {
    await t.engine.services.approvals.submit(id, token, SDA);
  } catch (e) {
    return e as ApprovalError;
  }
  throw new Error('expected submit to throw');
}

describe('invest preview', () => {
  test('dry quote: amounts, rate, fee, min received, expiry; Guard read; no card', async () => {
    const cards = t.messaging.cards.length;
    const p = (await t.engine.services.approvals.previewInvest(u.userId, 'SOL', '50')) as {
      ok: true;
      facts: { label: string; value: string }[];
      guard: { decision: string };
    };
    expect(p.ok).toBe(true);
    const f = Object.fromEntries(p.facts.map((x) => [x.label, x.value]));
    expect(f['You pay']).toBe('$50');
    expect(f["You'll get"]).toBe('about 0.499 SOL, at least 0.49401 SOL');
    expect(f.Fee).toBe('$0.10');
    expect(f.Price).toBe('1 SOL ≈ $100');
    expect(f['Price good for']).toBe('2 min');
    expect(f['Goes to']).toBe('your Penny wallet');
    expect(p.guard.decision).toBe('allow_with_approval');
    expect(t.messaging.cards.length).toBe(cards);
  });
  test('unknown asset is refused', async () => {
    expect(await t.engine.services.approvals.previewInvest(u.userId, 'DOGE', '5')).toMatchObject({
      ok: false,
    });
  });
});

describe('invest approval card', () => {
  test('firm quote -> card with deposit actions to the 1Click address', async () => {
    const before = t.invest.firmCalls;
    const r = await invest('10');
    expect(t.invest.firmCalls).toBe(before + 1);
    const row = await t.engine.repos.approvals.get(r.approvalId);
    if (!row) throw new Error('no row');
    const plan = row.plan as { quoteId: string };
    const q = t.invest.get(plan.quoteId);
    expect(q?.dry).toBe(false);
    const actions = row.actions as { methodName: string; args: unknown }[];
    expect(actions.map((a) => a.methodName)).toEqual(['storage_deposit', 'ft_transfer']);
    expect(actions[1]?.args).toEqual({ receiver_id: q?.depositAddress, amount: '10000000' });
    const labels = row.facts.map((f) => f.label);
    // the iPhone shows the first three: pay, get (with minimum), fee
    expect(labels).toEqual([
      'You pay',
      "You'll get",
      'Fee',
      'Price',
      'Price good for',
      'Goes to',
      'Daily limit',
    ]);
    expect(row.title).toBe('Buying $10 of SOL');
    expect(row.expiresAt.getTime() - t.clock.now.getTime()).toBeLessThanOrEqual(120_000);
    expect(t.messaging.cards.at(-1)?.card.subcaption).toBe(
      "You'll get about 0.0998 SOL · tap to approve",
    );
  });

  test('Guard block happens before any quote or card', async () => {
    const t2 = await makeEngine();
    const u2 = await enrolledUser(t2, '+15550222');
    const firm = t2.invest.firmCalls;
    const cards = t2.messaging.cards.length;
    const r = await t2.engine.services.approvals.createInvestApproval({
      userId: u2.userId,
      bot: null,
      asset: 'ETH',
      amountUsd: '500',
      space: u2.space,
    });
    expect(r.decision).toBe('block');
    expect(r.reasons.join(' ')).toContain('per-payment limit');
    expect(t2.invest.firmCalls).toBe(firm);
    expect(t2.messaging.cards.length).toBe(cards);
    await t2.db.close();
  }, 60_000);

  test('1Click down -> needs_more_info, no card', async () => {
    const cards = t.messaging.cards.length;
    t.invest.failNext = new Error('HTTP 503');
    const r = await t.engine.services.approvals.createInvestApproval({
      userId: u.userId,
      bot: null,
      asset: 'SOL',
      amountUsd: '5',
      space: u.space,
    });
    expect(r.decision).toBe('needs_more_info');
    expect(t.messaging.cards.length).toBe(cards);
  });
});

describe('approval re-checks the quote (re-card, never silently)', () => {
  test('expired quote -> old card expires, a fresh card is sent, nothing relayed', async () => {
    const r = await invest('7');
    const relays = t.chain.relayCalls.length;
    const cards = t.messaging.cards.length;
    t.clock.now = new Date(t.clock.now.getTime() + 121_000);
    const e = await submitErr(r.approvalId, r.cardToken);
    expect(e.code).toBe('requoted');
    expect((await t.engine.repos.approvals.get(r.approvalId))?.status).toBe('expired');
    expect(t.messaging.cards.length).toBe(cards + 1);
    expect(t.messaging.cards.at(-1)?.card.subcaption).toStartWith('New price.');
    expect(t.messaging.edits.at(-1)?.card.subcaption).toBe(
      'Price changed, check the new amount. Nothing moved.',
    );
    expect(t.chain.relayCalls.length).toBe(relays);
  });

  test('expiry sweeper ran first: an approve tap still re-quotes, once', async () => {
    const r = await invest('7.5');
    const cards = t.messaging.cards.length;
    t.clock.now = new Date(t.clock.now.getTime() + 121_000);
    expect(await t.engine.services.approvals.expireDue()).toBeGreaterThanOrEqual(1);
    expect((await t.engine.repos.approvals.get(r.approvalId))?.status).toBe('expired');
    const e = await submitErr(r.approvalId, r.cardToken);
    expect(e.code).toBe('requoted');
    expect(t.messaging.cards.length).toBe(cards + 1);
    const again = await submitErr(r.approvalId, r.cardToken);
    expect(again.code).toBe('expired');
    expect(t.messaging.cards.length).toBe(cards + 1);
  });

  test('decline on an expired invest card never buys a new quote', async () => {
    const r = await invest('7.25');
    const cards = t.messaging.cards.length;
    const firm = t.invest.firmCalls;
    t.clock.now = new Date(t.clock.now.getTime() + 121_000);
    let err: ApprovalError | null = null;
    try {
      await t.engine.services.approvals.decline(r.approvalId, r.cardToken);
    } catch (x) {
      err = x as ApprovalError;
    }
    expect(err?.code).toBe('expired');
    expect(t.messaging.cards.length).toBe(cards);
    expect(t.invest.firmCalls).toBe(firm);
  });

  test('price moved beyond slippage -> cancelled, new card, nothing relayed', async () => {
    const r = await invest('8');
    const relays = t.chain.relayCalls.length;
    const cards = t.messaging.cards.length;
    t.invest.prices.SOL = 103_000_000n; // +3%: fresh estimate < approved minimum (1%)
    const e = await submitErr(r.approvalId, r.cardToken);
    t.invest.prices.SOL = 100_000_000n;
    expect(e.code).toBe('requoted');
    expect((await t.engine.repos.approvals.get(r.approvalId))?.status).toBe('cancelled');
    expect(t.messaging.cards.length).toBe(cards + 1);
    expect(t.messaging.cards.at(-1)?.card.subcaption).toStartWith('New price.');
    expect(t.chain.relayCalls.length).toBe(relays);
    expect(t.chain.verifyCalls).not.toContain(r.approvalId);
  });

  test('price inside slippage -> verifies and relays (dry run settles)', async () => {
    const r = await invest('9');
    t.invest.prices.SOL = 100_500_000n; // +0.5%, inside 1%
    const out = await t.engine.services.approvals.submit(r.approvalId, r.cardToken, SDA);
    t.invest.prices.SOL = 100_000_000n;
    expect(out.status).toBe('settled');
    expect(t.chain.relayCalls).toContain(r.approvalId);
  });
});

describe('live swap status updates the card in place', () => {
  async function relayedLive(txHash: string) {
    const r = await invest('6');
    t.chain.nextRelay = { ok: true, txHash, dryRun: false };
    t.chain.statuses.set(txHash, 'settled');
    const out = await t.engine.services.approvals.submit(r.approvalId, r.cardToken, SDA);
    t.chain.nextRelay = null;
    const row = await t.engine.repos.approvals.get(r.approvalId);
    if (!row) throw new Error('no row');
    const dep = investDepositAddress(row.actions as NearAction[]);
    if (!dep) throw new Error('no deposit address');
    return { r, out, dep };
  }
  const lastEdit = (id: string) =>
    t.messaging.edits.filter((e) => e.handle.approvalId === id).at(-1);

  test('Sending -> Buying now -> Done, plain words, no links or hashes on the card; 1Click told', async () => {
    const { r, out, dep } = await relayedLive('HASH_OK');
    expect(out.status).toBe('relayed');
    expect(t.invest.notified.at(-1)).toEqual({
      txHash: 'HASH_OK',
      depositAddress: dep,
      sender: u.accountId,
    });
    expect(lastEdit(r.approvalId)?.card.subcaption).toBe('Sending…');
    expect(lastEdit(r.approvalId)?.card.trailingCaption).toBeUndefined();
    t.invest.statuses.set(dep, 'PROCESSING');
    await t.engine.services.approvals.refreshRelayed();
    expect(lastEdit(r.approvalId)?.card.subcaption).toBe('Buying now…');
    const edits = t.messaging.edits.length;
    await t.engine.services.approvals.refreshRelayed(); // unchanged state: no new edit
    expect(t.messaging.edits.length).toBe(edits);
    t.invest.statuses.set(dep, 'SUCCESS');
    await t.engine.services.approvals.refreshRelayed();
    expect(lastEdit(r.approvalId)?.card.subcaption).toStartWith('Done');
    expect((await t.engine.repos.approvals.get(r.approvalId))?.status).toBe('settled');
  });

  test('1Click status down right after relay -> submit still answers relayed', async () => {
    t.invest.statusError = new Error('HTTP 503');
    const { r, out } = await relayedLive('HASH_503');
    t.invest.statusError = null;
    expect(out.status).toBe('relayed');
    expect((await t.engine.repos.approvals.get(r.approvalId))?.status).toBe('relayed');
  });

  test('Refunded -> failed, ledger released, card says USDC is back', async () => {
    const { r, dep } = await relayedLive('HASH_REFUND');
    t.invest.statuses.set(dep, 'REFUNDED');
    await t.engine.services.approvals.refreshRelayed();
    expect(lastEdit(r.approvalId)?.card.subcaption).toBe('Refunded to you');
    expect((await t.engine.repos.approvals.get(r.approvalId))?.status).toBe('failed');
    const res = (await t.db.db.execute(
      sql`select status from ledger_entries where approval_id = ${r.approvalId}`,
    )) as unknown as { rows: { status: string }[] };
    expect(res.rows[0]?.status).toBe('released');
  });

  test('Failed -> failed', async () => {
    const { r, dep } = await relayedLive('HASH_FAIL');
    t.invest.statuses.set(dep, 'FAILED');
    await t.engine.services.approvals.refreshRelayed();
    expect(lastEdit(r.approvalId)?.card.subcaption).toStartWith("Didn't go through");
    expect((await t.engine.repos.approvals.get(r.approvalId))?.status).toBe('failed');
  });

  test('status mapping and amount formatting', () => {
    expect(mapSwapStatus('KNOWN_DEPOSIT_TX')).toBe('pending');
    expect(mapSwapStatus('INCOMPLETE_DEPOSIT')).toBe('pending');
    expect(mapSwapStatus('PROCESSING')).toBe('processing');
    expect(formatUnits(11_066_177n, 9)).toBe('0.011066');
    expect(formatUnits(445_427_595_066_585n, 18)).toBe('0.000445');
    expect(formatUnits(12n, 18)).toBe('0.000000000000000012');
  });
});

describe('plain words on every user-facing invest string', () => {
  test('cards, rows, statuses and errors carry no chain or swap jargon', async () => {
    const jargon =
      /1click|intents|deposit|delegate|relayer|slippage|nonce|\bgas\b|base units|hash|\.near\b|blockchain|usdc|quote|est\./i;
    const seen: string[] = [];
    for (const c of t.messaging.cards) seen.push(c.card.caption, c.card.subcaption ?? '');
    for (const e of t.messaging.edits)
      seen.push(e.card.subcaption ?? '', e.card.trailingCaption ?? '');
    const rows = (await t.db.db.execute(
      sql`select title, facts from approvals where kind = 'invest'`,
    )) as unknown as { rows: { title: string; facts: { label: string; value: string }[] }[] };
    for (const r of rows.rows) {
      seen.push(r.title);
      for (const f of r.facts) seen.push(f.label, f.value);
    }
    expect(seen.length).toBeGreaterThan(20);
    expect(seen.filter((x) => jargon.test(x))).toEqual([]);
  });
});

describe('mainnet launch caps and relayer ceiling', () => {
  test('mainnet daily cap bounds the daily total, before the card and before relay', async () => {
    const t3 = await makeEngine({
      extra: { mainnetMaxPerTxUsd: '25', mainnetMaxDailyUsd: '30' },
    });
    const u3 = await enrolledUser(t3, '+15550333');
    const svc = t3.engine.services.approvals;
    const a = await svc.createInvestApproval({
      userId: u3.userId,
      bot: null,
      asset: 'NEAR',
      amountUsd: '20',
      space: u3.space,
    });
    expect(a.decision).toBe('allow_with_approval');
    const b = await svc.createInvestApproval({
      userId: u3.userId,
      bot: null,
      asset: 'NEAR',
      amountUsd: '20',
      space: u3.space,
    });
    expect(b.decision).toBe('block');
    expect(b.reasons.join(' ')).toContain('$30.00 daily limit');
    expect((await svc.effectivePolicy(u3.userId)).dailyUsd).toBe('30');
    await t3.db.close();
  }, 60_000);

  test('relayer ceiling blocks a NEAR send over the env ceiling before the card', async () => {
    const t4 = await makeEngine({ extra: { relayerMaxDepositYocto: 10n ** 23n } });
    const u4 = await enrolledUser(t4, '+15550444');
    const svc = t4.engine.services.approvals;
    const big = await svc.createMoneyApproval({
      userId: u4.userId,
      bot: null,
      plan: { kind: 'send', asset: 'NEAR', amount: '0.5', to: 'ada.penny.near' },
      space: u4.space,
      nearUsdPriceMicros: 4_000_000n,
    });
    expect(big.decision).toBe('block');
    expect(t4.messaging.cards.length).toBe(0);
    const small = await svc.createMoneyApproval({
      userId: u4.userId,
      bot: null,
      plan: { kind: 'send', asset: 'NEAR', amount: '0.05', to: 'ada.penny.near' },
      space: u4.space,
      nearUsdPriceMicros: 4_000_000n,
    });
    expect(small.decision).toBe('allow_with_approval');
    await t4.db.close();
  }, 60_000);
});
