import { describe, expect, test } from 'bun:test';
import {
  buildDepositActions,
  isQuoteFresh,
  OneClickClient,
  QuoteRejected,
} from '../src/intents/oneclick.ts';
import { USDC_ASSET_ID } from '../src/near/ft.ts';
import type { FetchLike } from '../src/util/http.ts';

const NOW = new Date('2026-11-05T19:00:00.000Z');
const DEST = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';
const DEP = 'a'.repeat(64);

function quoteBody(req: Record<string, unknown>, over: Record<string, unknown> = {}) {
  const dry = req.dry as boolean;
  return {
    correlationId: 'c1',
    timestamp: NOW.toISOString(),
    signature: 'ed25519:sig',
    quoteRequest: { ...req, depositMode: 'SIMPLE', appFees: [] },
    quote: {
      ...(dry
        ? {}
        : {
            depositAddress: DEP,
            deadline: new Date(NOW.getTime() + 600_000).toISOString(),
            timeWhenInactive: new Date(NOW.getTime() + 600_000).toISOString(),
          }),
      amountIn: req.amount,
      amountInFormatted: '50',
      amountInUsd: '50',
      minAmountIn: req.amount,
      amountOut: '49800000',
      amountOutFormatted: '49.8',
      amountOutUsd: '49.8',
      minAmountOut: '49302000',
      timeEstimate: 20,
      ...over,
    },
  };
}

function client(over: Record<string, unknown> = {}, reqOver: Record<string, unknown> = {}) {
  const seen: { url: string; init?: RequestInit }[] = [];
  const f: FetchLike = async (url, init) => {
    seen.push({ url, ...(init ? { init } : {}) });
    if (url.endsWith('/v0/tokens')) {
      return Response.json([
        {
          assetId: USDC_ASSET_ID,
          decimals: 6,
          blockchain: 'near',
          symbol: 'USDC',
          price: 0.9995,
          priceUpdatedAt: NOW.toISOString(),
          contractAddress: USDC_ASSET_ID.slice(7),
        },
      ]);
    }
    if (url.includes('/v0/status')) {
      const req = {
        dry: false,
        swapType: 'EXACT_INPUT',
        slippageTolerance: 100,
        originAsset: USDC_ASSET_ID,
        depositType: 'ORIGIN_CHAIN',
        destinationAsset: DEST,
        amount: '50000000',
        refundTo: 'tobi.penny.near',
        refundType: 'ORIGIN_CHAIN',
        recipient: '0x0000000000000000000000000000000000000001',
        recipientType: 'DESTINATION_CHAIN',
        deadline: NOW.toISOString(),
      };
      return Response.json({
        correlationId: 'c2',
        quoteResponse: quoteBody(req),
        status: 'SUCCESS',
        updatedAt: NOW.toISOString(),
        swapDetails: { nearTxHashes: ['h'], amountOut: '49800000' },
      });
    }
    const req = { ...(JSON.parse(String(init?.body)) as Record<string, unknown>), ...reqOver };
    return Response.json(quoteBody(req, over));
  };
  return { c: new OneClickClient({ fetch: f, now: () => NOW, apiKey: 'k_test' }), seen };
}

const params = (dry: boolean) => ({
  dry,
  originAsset: USDC_ASSET_ID,
  destinationAsset: DEST,
  amount: 50_000_000n,
  slippageBps: 100,
  recipient: '0x0000000000000000000000000000000000000001',
  refundTo: 'tobi.penny.near',
});

describe('OneClickClient', () => {
  test('getTokens parses and sends X-API-Key', async () => {
    const { c, seen } = client();
    const t = await c.getTokens();
    expect(t[0]?.symbol).toBe('USDC');
    expect(((seen[0]?.init?.headers ?? {}) as Record<string, string>)['X-API-Key']).toBe('k_test');
  });

  test('dry quote: validated, bigint amounts, no deposit address, 120s expiry', async () => {
    const { c, seen } = client();
    const q = await c.quote(params(true));
    expect(q.amountIn).toBe(50_000_000n);
    expect(q.minAmountOut).toBe(49_302_000n);
    expect(q.depositAddress).toBeUndefined();
    expect(q.expiresAt.getTime() - NOW.getTime()).toBe(120_000);
    const sent = JSON.parse(String(seen[0]?.init?.body)) as Record<string, unknown>;
    expect(sent.amount).toBe('50000000');
    expect(sent.slippageTolerance).toBe(100);
    expect(sent.depositType).toBe('ORIGIN_CHAIN');
    expect(isQuoteFresh(q, NOW)).toBe(true);
    expect(isQuoteFresh(q, new Date(NOW.getTime() + 121_000))).toBe(false);
  });

  test('rejects echo tampering (recipient swapped)', async () => {
    const { c } = client({}, { recipient: '0xattacker' });
    await expect(c.quote(params(true))).rejects.toMatchObject({ code: 'ECHO_MISMATCH' });
  });
  test('rejects minAmountOut outside slippage bound', async () => {
    const { c } = client({ minAmountOut: '40000000' });
    await expect(c.quote(params(true))).rejects.toMatchObject({ code: 'SLIPPAGE_BOUND' });
  });
  test('accepts a floored minAmountOut exactly at the bound (live 1Click behaviour)', async () => {
    // live 2026-11-05: amountOut 271380402993645538628944, minAmountOut 268666598963709083242654 at 100 bps
    const { c } = client({
      amountOut: '271380402993645538628944',
      minAmountOut: '268666598963709083242654',
    });
    expect((await c.quote(params(true))).minAmountOut).toBe(268666598963709083242654n);
    const { c: c2 } = client({
      amountOut: '271380402993645538628944',
      minAmountOut: '268666598963709083242653',
    });
    await expect(c2.quote(params(true))).rejects.toMatchObject({ code: 'SLIPPAGE_BOUND' });
  });
  test('rejects minAmountOut above amountOut', async () => {
    const { c } = client({ minAmountOut: '50000000' });
    await expect(c.quote(params(true))).rejects.toMatchObject({ code: 'SLIPPAGE_BOUND' });
  });
  test('enforces minReceived', async () => {
    const { c } = client();
    await expect(c.quote(params(true), { minReceived: 49_500_000n })).rejects.toMatchObject({
      code: 'MIN_RECEIVED',
    });
  });
  test('rejects excessive slippage request and AmountIn mismatch', async () => {
    const { c } = client();
    await expect(c.quote({ ...params(true), slippageBps: 5000 })).rejects.toBeInstanceOf(
      QuoteRejected,
    );
    const { c: c2 } = client({ amountIn: '49999999' });
    await expect(c2.quote(params(true))).rejects.toMatchObject({ code: 'AMOUNT_IN_MISMATCH' });
  });
  test('live quote requires deposit address and clamps expiry', async () => {
    const { c } = client();
    const q = await c.quote(params(false));
    expect(q.depositAddress).toBe(DEP);
    expect(q.expiresAt.getTime() - NOW.getTime()).toBe(120_000);
    const { c: c2 } = client({ depositAddress: undefined });
    await expect(c2.quote(params(false))).rejects.toMatchObject({
      code: 'MISSING_DEPOSIT_ADDRESS',
    });
    const { c: c3 } = client({ deadline: new Date(NOW.getTime() + 30_000).toISOString() });
    expect((await c3.quote(params(false))).expiresAt.getTime() - NOW.getTime()).toBe(30_000);
    const { c: c4 } = client({ deadline: new Date(NOW.getTime() - 1).toISOString() });
    await expect(c4.quote(params(false))).rejects.toMatchObject({ code: 'EXPIRED' });
  });
  test('status parses', async () => {
    const { c, seen } = client();
    const s = await c.status(DEP);
    expect(s.status).toBe('SUCCESS');
    expect(seen[0]?.url).toContain(`depositAddress=${DEP}`);
  });
});

describe('buildDepositActions', () => {
  test('ft_transfer to the deposit address (+storage_deposit when unregistered)', async () => {
    const { c } = client();
    const q = await c.quote(params(false));
    const a = buildDepositActions(q, { depositAddressRegistered: false });
    expect(a.receiverId).toBe(USDC_ASSET_ID.slice(7));
    expect(a.actions.map((x) => (x.type === 'FunctionCall' ? x.methodName : x.type))).toEqual([
      'storage_deposit',
      'ft_transfer',
    ]);
    expect(a.actions[1]).toEqual({
      type: 'FunctionCall',
      methodName: 'ft_transfer',
      args: { receiver_id: DEP, amount: '50000000' },
      gas: '30000000000000',
      deposit: '1',
    });
    expect(buildDepositActions(q, { depositAddressRegistered: true }).actions).toHaveLength(1);
  });
  test('refuses dry quotes', async () => {
    const { c } = client();
    const q = await c.quote(params(true));
    expect(() => buildDepositActions(q, { depositAddressRegistered: true })).toThrow(QuoteRejected);
  });
});
