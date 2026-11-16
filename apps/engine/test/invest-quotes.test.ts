import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { ChainAdapter, NearRpc, OneClickClient } from '@penny/chain';
import liveSol from '../../../packages/chain/test/fixtures/oneclick/quote-live-sol.json';
import statusPending from '../../../packages/chain/test/fixtures/oneclick/status-pending.json';
import { createPgliteDb, type DbHandle } from '../src/db/client.ts';
import { IntentsInvest } from '../src/market/intents.ts';
import { InvestQuotesRepo } from '../src/repo/invest-quotes.ts';

/**
 * Quote persistence: a firm quote written before the card went out must still be
 * usable by an engine that restarted in the meantime. The old behaviour was "price
 * expired" on the tap, because the quote only ever lived in a Map.
 */
const NOW = new Date(liveSol.timestamp);
const USER = 'penny.near';

let dbh: DbHandle;
let store: InvestQuotesRepo;

beforeAll(async () => {
  dbh = await createPgliteDb();
  store = new InvestQuotesRepo(dbh.db);
});
afterAll(async () => {
  await dbh?.close();
});

/** A real 1Click recording, replayed; the RPC says the deposit address is unregistered. */
function world() {
  const oneClickFetch = async (url: string, init?: RequestInit) => {
    if (url.includes('/v0/status')) return Response.json(statusPending);
    if (url.includes('/v0/deposit/submit')) return Response.json(statusPending);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({
      ...liveSol,
      quoteRequest: { ...liveSol.quoteRequest, ...body },
    });
  };
  const rpcFetch = async (_url: string, init?: RequestInit) => {
    const req = JSON.parse(String(init?.body)) as { id: string };
    const result = { result: [...new TextEncoder().encode('null')], logs: [], block_height: 1 };
    return Response.json({ jsonrpc: '2.0', id: req.id, result });
  };
  const adapter = (
    loadInvestQuote?: (id: string) => Promise<Awaited<ReturnType<InvestQuotesRepo['validated']>>>,
  ) =>
    new ChainAdapter({
      rpc: new NearRpc({ url: 'https://rpc.mainnet.fastnear.com', fetch: rpcFetch }),
      appAccountId: 'penny.near',
      relayerAccountId: 'penny.near',
      oneClick: new OneClickClient({ fetch: oneClickFetch, now: () => NOW }),
      now: () => NOW,
      ...(loadInvestQuote ? { loadInvestQuote } : {}),
    });
  return { adapter, rpcFetch, oneClickFetch };
}

describe('invest quote persistence', () => {
  test('a firm quote survives a "restart" and still builds the same deposit', async () => {
    const a = world();
    const first = new IntentsInvest({ adapter: a.adapter(), now: () => NOW, quotes: store });
    const q = await first.firm('SOL', '1', USER);
    expect(q.depositAddress).toBe(liveSol.quote.depositAddress);

    // New process: empty memory, same database.
    const b = world();
    const adapterB = b.adapter((id) => store.validated(id));
    const second = new IntentsInvest({ adapter: adapterB, now: () => NOW, quotes: store });
    const restored = await second.get(q.quoteId);
    expect(restored).toBeDefined();
    expect(restored?.depositAddress).toBe(q.depositAddress);
    expect(restored?.minAmountOut).toBe(q.minAmountOut);
    expect(restored?.amountOutDisplay).toBe(q.amountOutDisplay);
    expect(restored?.dry).toBe(false);

    const built = await adapterB.buildActions(
      { kind: 'invest', amountUsd: '1', portfolioId: 'SOL', quoteId: q.quoteId },
      USER,
    );
    const transfer = built.actions.find(
      (x) => x.type === 'FunctionCall' && x.methodName === 'ft_transfer',
    );
    expect(transfer?.type === 'FunctionCall' && transfer.args).toEqual({
      receiver_id: liveSol.quote.depositAddress,
      amount: '1000000',
    });
  });

  test('without the loader the fresh adapter refuses an unknown quote', async () => {
    const a = world();
    const first = new IntentsInvest({ adapter: a.adapter(), now: () => NOW, quotes: store });
    const q = await first.firm('SOL', '1', USER);
    const b = world();
    await expect(
      b
        .adapter()
        .buildActions(
          { kind: 'invest', amountUsd: '1', portfolioId: 'SOL', quoteId: q.quoteId },
          USER,
        ),
    ).rejects.toThrow(/unknown quote/);
  });

  test('previews are not stored: nothing can be signed from one', async () => {
    const a = world();
    const inv = new IntentsInvest({ adapter: a.adapter(), now: () => NOW, quotes: store });
    const p = await inv.preview('SOL', '1', USER);
    expect(await store.get(p.quoteId)).toBeNull();
    expect(await inv.get(p.quoteId)).toBeDefined(); // still in memory, as before
  });

  test('prune drops rows past the cutoff and keeps the rest', async () => {
    const a = world();
    const inv = new IntentsInvest({ adapter: a.adapter(), now: () => NOW, quotes: store });
    const keep = await inv.firm('SOL', '1', USER);
    await store.prune(new Date(NOW.getTime() - 60 * 60_000));
    expect(await store.get(keep.quoteId)).not.toBeNull();
    await store.prune(new Date(keep.expiresAt.getTime() + 1));
    expect(await store.get(keep.quoteId)).toBeNull();
  });
});
