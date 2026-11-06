import { describe, expect, test } from 'bun:test';
import liveSol from './fixtures/oneclick/quote-live-sol.json';
import dryEth from './fixtures/oneclick/quote-dry-eth.json';
import dryNear from './fixtures/oneclick/quote-dry-near.json';
import drySol from './fixtures/oneclick/quote-dry-sol.json';
import statusPending from './fixtures/oneclick/status-pending.json';
import tokens from './fixtures/oneclick/tokens.json';
import {
  buildDepositActions,
  isTerminalSwapStatus,
  OneClickClient,
  QuoteResponseSchema,
  quoteFeeBps,
  StatusSchema,
  swapExplorerLinks,
  TokenSchema,
  validateQuote,
} from '../src/intents/oneclick.ts';
import { USDC_ASSET_ID } from '../src/near/ft.ts';
import { NEAR_ACCOUNT_RE } from '../src/near/types.ts';
import type { FetchLike } from '../src/util/http.ts';

/**
 * Real 1Click responses recorded 2026-11-06 (USDC on NEAR -> SOL/ETH/wNEAR, $1, 100 bps,
 * recipientType INTENTS, no API key). The live (non-dry) quote moved no money.
 */
const sentFor = (res: { quoteRequest: Record<string, unknown> }) => ({
  dry: res.quoteRequest.dry as boolean,
  swapType: res.quoteRequest.swapType as string,
  originAsset: res.quoteRequest.originAsset as string,
  destinationAsset: res.quoteRequest.destinationAsset as string,
  amount: res.quoteRequest.amount as string,
  recipient: res.quoteRequest.recipient as string,
  refundTo: res.quoteRequest.refundTo as string,
  slippageTolerance: res.quoteRequest.slippageTolerance as number,
});

describe('recorded 1Click responses parse and validate', () => {
  test('tokens carry ETH, SOL, wNEAR and USDC prices', () => {
    const t = tokens.map((x) => TokenSchema.parse(x));
    expect(t.map((x) => x.symbol).sort()).toEqual(['ETH', 'SOL', 'USDC', 'wNEAR']);
    expect(t.find((x) => x.assetId === USDC_ASSET_ID)?.decimals).toBe(6);
  });

  test('dry quotes: no deposit address, minAmountOut within 100 bps', () => {
    for (const raw of [drySol, dryEth, dryNear]) {
      const res = QuoteResponseSchema.parse(raw);
      const now = new Date(res.timestamp);
      const v = validateQuote(res, sentFor(res), {}, now);
      expect(v.depositAddress).toBeUndefined();
      expect(v.amountIn).toBe(1_000_000n);
      expect(v.minAmountOut).toBeLessThan(v.amountOut);
      expect(v.expiresAt.getTime() - now.getTime()).toBe(120_000);
    }
  });

  test('live quote: implicit-account deposit address, 120 s cap, 20 bps keyless fee', () => {
    const res = QuoteResponseSchema.parse(liveSol);
    const now = new Date(res.timestamp);
    const v = validateQuote(res, sentFor(res), {}, now);
    expect(v.depositAddress).toMatch(/^[0-9a-f]{64}$/);
    expect(NEAR_ACCOUNT_RE.test(v.depositAddress ?? '')).toBe(true);
    expect(v.amountOut).toBe(11_066_177n);
    expect(v.minAmountOut).toBe(10_955_515n);
    expect(v.expiresAt.getTime() - now.getTime()).toBe(120_000);
    expect(quoteFeeBps(res)).toBe(20);
  });

  test('live quote builds storage_deposit + plain ft_transfer to the deposit address', () => {
    const res = QuoteResponseSchema.parse(liveSol);
    const v = validateQuote(res, sentFor(res), {}, new Date(res.timestamp));
    const plan = buildDepositActions(v, { depositAddressRegistered: false });
    expect(plan.receiverId).toBe(USDC_ASSET_ID.slice('nep141:'.length));
    expect(plan.actions.map((a) => (a.type === 'FunctionCall' ? a.methodName : a.type))).toEqual([
      'storage_deposit',
      'ft_transfer',
    ]);
    const ft = plan.actions[1];
    expect(ft?.type === 'FunctionCall' && ft.args).toEqual({
      receiver_id: v.depositAddress,
      amount: '1000000',
    });
    expect(ft?.deposit).toBe('1');
    expect(plan.actions[0]?.deposit).toBe('1250000000000000000000');
    expect(buildDepositActions(v, { depositAddressRegistered: true }).actions).toHaveLength(1);
  });

  test('a tampered echo (recipient swapped) is rejected', () => {
    const res = QuoteResponseSchema.parse(liveSol);
    expect(() =>
      validateQuote(res, { ...sentFor(res), recipient: 'evil.near' }, {}, new Date(res.timestamp)),
    ).toThrow('echo mismatch');
  });

  test('status: pending (nulls in swapDetails) parses; terminal set', () => {
    const s = StatusSchema.parse(statusPending);
    expect(s.status).toBe('PENDING_DEPOSIT');
    expect(isTerminalSwapStatus(s.status)).toBe(false);
    for (const st of ['PROCESSING', 'SUCCESS', 'REFUNDED', 'FAILED'] as const) {
      const x = StatusSchema.parse({ ...statusPending, status: st });
      expect(isTerminalSwapStatus(x.status)).toBe(st !== 'PROCESSING');
    }
  });

  test('explorer links', () => {
    expect(swapExplorerLinks('ab', 'H1')).toEqual({
      intents: 'https://explorer.near-intents.org/transactions/ab',
      nearTx: 'https://nearblocks.io/txns/H1',
    });
  });
});

describe('client calls', () => {
  function client(o: { jwt?: string; apiKey?: string } = {}) {
    const seen: { url: string; init?: RequestInit }[] = [];
    const f: FetchLike = async (url, init) => {
      seen.push({ url, ...(init ? { init } : {}) });
      if (url.includes('/v0/deposit/submit') || url.includes('/v0/status'))
        return Response.json(statusPending);
      return Response.json(tokens);
    };
    return { c: new OneClickClient({ fetch: f, ...o }), seen };
  }
  test('submitDeposit posts txHash, depositAddress and nearSenderAccount', async () => {
    const { c, seen } = client();
    const s = await c.submitDeposit({
      txHash: 'H',
      depositAddress: 'dep',
      nearSenderAccount: 'tobi.penny.near',
    });
    expect(s.status).toBe('PENDING_DEPOSIT');
    expect(seen[0]?.url).toEndWith('/v0/deposit/submit');
    expect(JSON.parse(String(seen[0]?.init?.body))).toEqual({
      txHash: 'H',
      depositAddress: 'dep',
      nearSenderAccount: 'tobi.penny.near',
    });
  });
  test('status polls by deposit address', async () => {
    const { c, seen } = client();
    await c.status('ac10');
    expect(seen[0]?.url).toEndWith('/v0/status?depositAddress=ac10');
  });
  test('JWT goes in a bearer header; keyless sends none', async () => {
    const a = client({ jwt: 'j.w.t' });
    await a.c.getTokens();
    expect((a.seen[0]?.init?.headers as Record<string, string>).authorization).toBe(
      'Bearer j.w.t',
    );
    expect(a.c.authenticated).toBe(true);
    const b = client();
    await b.c.getTokens();
    expect((b.seen[0]?.init?.headers as Record<string, string>).authorization).toBeUndefined();
    expect(b.c.authenticated).toBe(false);
  });
});
