import { describe, expect, test } from 'bun:test';
import { GliderClient, resolveDepositAddress } from '../src/glider/client.ts';
import type { FetchLike } from '../src/util/http.ts';

const portfolio = {
  portfolioId: 'p1',
  portfolioName: 'Tobi ETH',
  ownerAccountId: 'eip155:0:0xabcdef0000000000000000000000000000000001',
  strategyId: 's1',
  strategyName: 'ETH Momentum',
  strategyDescription: null,
  schedule: null,
  smartAccounts: [{ accountId: 'eip155:8453:0xe3a2d1f49aee887e42655b56371d4d76bbf58058' }],
  createdAt: '2026-11-05T00:00:00Z',
};

function mk() {
  const seen: { url: string; init?: RequestInit }[] = [];
  const f: FetchLike = async (url, init) => {
    seen.push({ url, ...(init ? { init } : {}) });
    const u = new URL(url);
    if (u.pathname === '/v2/strategies')
      return Response.json({
        success: true,
        data: {
          strategies: [
            {
              strategyId: 's1',
              name: 'ETH Momentum',
              description: 'x',
              allocation: {},
              schedule: {},
              preferences: {},
              isPublic: true,
              version: 1,
              createdAt: 'now',
            },
          ],
        },
        nextCursor: null,
      });
    if (u.pathname === '/v2/portfolios')
      return Response.json({ success: true, data: { portfolios: [portfolio] }, nextCursor: 'c2' });
    if (u.pathname === '/v2/portfolios/p1')
      return Response.json({ success: true, data: portfolio });
    if (u.pathname === '/v2/enroll/signature')
      return Response.json({
        success: true,
        data: {
          message: { kind: 'ecdsa', raw: '0xdead' },
          agentAccountId: 'eip155:0:0x1111111111111111111111111111111111111111',
          accountIndex: '7',
          accountType: 'ECDSA',
          flowId: 'flow_1',
        },
      });
    if (u.pathname === '/v2/enroll')
      return Response.json(
        {
          success: true,
          data: {
            portfolioId: 'p1',
            portfolioName: 'Tobi ETH',
            strategyId: 's1',
            smartAccounts: portfolio.smartAccounts,
          },
        },
        { status: 201 },
      );
    return Response.json({ success: false, error: { code: 'API_404' } }, { status: 404 });
  };
  return { g: new GliderClient({ apiKey: 'gldr_sk_test', fetch: f }), seen };
}

describe('GliderClient', () => {
  test('requires a key and never serialises it', () => {
    expect(() => new GliderClient({ apiKey: '' })).toThrow();
    expect(JSON.stringify(mk().g)).not.toContain('gldr_sk_test');
  });
  test('lists strategies and portfolios with x-api-key', async () => {
    const { g, seen } = mk();
    expect((await g.listStrategies({ limit: 5 })).strategies[0]?.name).toBe('ETH Momentum');
    const p = await g.listPortfolios({ ownerAccountId: portfolio.ownerAccountId });
    expect(p.nextCursor).toBe('c2');
    expect(((seen[0]?.init?.headers ?? {}) as Record<string, string>)['x-api-key']).toBe(
      'gldr_sk_test',
    );
    expect(seen[1]?.url).toContain('ownerAccountId=eip155%3A0%3A');
  });
  test('two-stage enrollment echoes round-trip fields unchanged', async () => {
    const { g, seen } = mk();
    const req = {
      ownerAccountId: 'eip155:0:0xabcdef0000000000000000000000000000000001',
      strategyId: 's1',
      chainIds: [8453],
    };
    const s1 = await g.prepareEnrollment(req);
    expect(s1.message.kind).toBe('ecdsa');
    const s2 = await g.enroll(req, s1, '0xsig', 'Tobi ETH');
    expect(s2.portfolioId).toBe('p1');
    const body = JSON.parse(String(seen[1]?.init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      accountIndex: '7',
      flowId: 'flow_1',
      agentAccountId: s1.agentAccountId,
      chainIds: [8453],
      signature: '0xsig',
    });
    expect(typeof body.accountIndex).toBe('string');
  });
  test('rejects chain-bound owner ids', async () => {
    const { g } = mk();
    await expect(
      g.prepareEnrollment({
        ownerAccountId: 'eip155:8453:0xabc',
        strategyId: 's1',
        chainIds: [8453],
      }),
    ).rejects.toThrow();
  });
  test('resolveDepositAddress picks the chain smart account', async () => {
    const { g } = mk();
    const p = await g.getPortfolio('p1');
    expect(resolveDepositAddress(p, 8453)).toBe('0xe3a2d1f49aee887e42655b56371d4d76bbf58058');
    expect(() => resolveDepositAddress(p, 1)).toThrow();
  });
});
