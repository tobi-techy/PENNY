import { describe, expect, test } from 'bun:test';
import { ChainAdapter, NearRpc, OneClickClient } from '@penny/chain';
import drySol from '../../../packages/chain/test/fixtures/oneclick/quote-dry-sol.json';
import liveSol from '../../../packages/chain/test/fixtures/oneclick/quote-live-sol.json';
import statusPending from '../../../packages/chain/test/fixtures/oneclick/status-pending.json';
import { IntentsInvest } from '../src/market/intents.ts';

/**
 * IntentsInvest on the real ChainAdapter, fed real recorded 1Click responses
 * (2026-11-06, USDC -> SOL, $1). RPC is a stub: the deposit address is unregistered on USDC.
 */
const NOW = new Date(liveSol.timestamp);
const USER = 'penny.near';

function world(opts: { moveTo?: string } = {}) {
  const posts: Record<string, unknown>[] = [];
  const oneClickFetch = async (url: string, init?: RequestInit) => {
    if (url.includes('/v0/status')) return Response.json(statusPending);
    if (url.includes('/v0/deposit/submit')) return Response.json(statusPending);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    posts.push(body);
    const src = body.dry ? drySol : liveSol;
    // echo exactly what was sent (deadline differs from the recording), keep 1Click's numbers
    const moved =
      body.dry && opts.moveTo
        ? {
            amountOut: opts.moveTo,
            minAmountOut: ((BigInt(opts.moveTo) * 9900n) / 10_000n).toString(),
          }
        : {};
    const quote = { ...src.quote, ...moved };
    return Response.json({ ...src, quoteRequest: { ...src.quoteRequest, ...body }, quote });
  };
  const rpcFetch = async (_url: string, init?: RequestInit) => {
    const req = JSON.parse(String(init?.body)) as { id: string; params: { method_name?: string } };
    // storage_balance_of -> null (deposit address not registered yet)
    const result = { result: [...new TextEncoder().encode('null')], logs: [], block_height: 1 };
    return Response.json({ jsonrpc: '2.0', id: req.id, result });
  };
  const adapter = new ChainAdapter({
    rpc: new NearRpc({ url: 'https://rpc.mainnet.fastnear.com', fetch: rpcFetch }),
    appAccountId: 'penny.near',
    relayerAccountId: 'penny.near',
    oneClick: new OneClickClient({ fetch: oneClickFetch, now: () => NOW }),
    now: () => NOW,
  });
  return { inv: new IntentsInvest({ adapter, now: () => NOW }), adapter, posts };
}

describe('IntentsInvest on the real adapter (recorded 1Click)', () => {
  test('preview is dry, recipientType INTENTS to the user, refund to the user', async () => {
    const { inv, posts } = world();
    const q = await inv.preview('SOL', '1', USER);
    expect(q.dry).toBe(true);
    expect(q.depositAddress).toBeUndefined();
    expect(posts[0]).toMatchObject({
      dry: true,
      recipient: USER,
      recipientType: 'INTENTS',
      refundTo: USER,
      refundType: 'ORIGIN_CHAIN',
      depositType: 'ORIGIN_CHAIN',
      slippageTolerance: 100,
      amount: '1000000',
      destinationAsset: 'nep141:sol.omft.near',
    });
    expect(typeof posts[0]?.deadline).toBe('string');
    expect(q.keyless).toBe(true);
    expect(q.feeBps).toBe(20);
  });

  test('firm quote registers with buildActions: storage_deposit + ft_transfer to the deposit address', async () => {
    const { inv, adapter } = world();
    const q = await inv.firm('SOL', '1', USER);
    expect(q.dry).toBe(false);
    expect(q.depositAddress).toBe(liveSol.quote.depositAddress);
    expect(q.amountOutDisplay).toBe('0.011066 SOL');
    expect(q.minOutDisplay).toBe('0.010955 SOL');
    expect(q.rateDisplay).toBe('1 SOL ≈ $90.36');
    expect(q.expiresAt.getTime() - NOW.getTime()).toBe(120_000);
    const built = await adapter.buildActions(
      { kind: 'invest', amountUsd: '1', portfolioId: 'SOL', quoteId: q.quoteId },
      USER,
    );
    expect(built.receiverId).toBe(
      '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
    );
    expect(built.actions).toEqual([
      {
        type: 'FunctionCall',
        methodName: 'storage_deposit',
        args: { account_id: liveSol.quote.depositAddress, registration_only: true },
        gas: '10000000000000',
        deposit: '1250000000000000000000',
      },
      {
        type: 'FunctionCall',
        methodName: 'ft_transfer',
        args: { receiver_id: liveSol.quote.depositAddress, amount: '1000000' },
        gas: '30000000000000',
        deposit: '1',
      },
    ]);
  });

  test('recheck: inside slippage ok; below the guaranteed minimum -> price_moved', async () => {
    const a = world();
    const q = await a.inv.firm('SOL', '1', USER);
    expect((await a.inv.recheck(q)).ok).toBe(true);
    const b = world({ moveTo: '10900000' }); // < minAmountOut 10955515
    const q2 = await b.inv.firm('SOL', '1', USER);
    expect(await b.inv.recheck(q2)).toMatchObject({ ok: false, reason: 'price_moved' });
  });

  test('status maps PENDING_DEPOSIT to pending', async () => {
    const { inv } = world();
    expect(await inv.status(liveSol.quote.depositAddress)).toMatchObject({
      state: 'pending',
      raw: 'PENDING_DEPOSIT',
    });
  });
});
