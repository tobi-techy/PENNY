import { describe, expect, test } from 'bun:test';
import tokens from './fixtures/oneclick/tokens.json';
import { OneClickClient } from '../src/intents/oneclick.ts';
import {
  isInvestAsset,
  microsToUsd,
  PriceFeed,
  PriceUnavailable,
  usdNumberToMicros,
} from '../src/intents/prices.ts';
import type { FetchLike } from '../src/util/http.ts';

const RECORDED_AT = new Date(tokens[0]?.priceUpdatedAt ?? 0);

function feed(o: { oneClickDown?: boolean; geckoDown?: boolean; now?: () => Date } = {}) {
  let calls = 0;
  const f: FetchLike = async (url) => {
    calls += 1;
    if (url.includes('1click')) {
      if (o.oneClickDown) return new Response('down', { status: 503 });
      return Response.json(tokens);
    }
    if (o.geckoDown) return new Response('nope', { status: 429 });
    const at = Math.floor((o.now ?? (() => RECORDED_AT))().getTime() / 1000) - 60;
    return Response.json({
      ethereum: { usd: 2200.5, last_updated_at: at },
      solana: { usd: 91, last_updated_at: at },
      near: { usd: 3.7, last_updated_at: at },
    });
  };
  const now = o.now ?? (() => RECORDED_AT);
  const pf = new PriceFeed({ oneClick: new OneClickClient({ fetch: f }), fetch: f, now });
  return { pf, calls: () => calls };
}

describe('PriceFeed', () => {
  test('reads ETH/SOL/NEAR from recorded 1Click tokens, cached', async () => {
    const { pf, calls } = feed();
    const sol = await pf.get('SOL');
    expect(sol.source).toBe('near-intents');
    expect(sol.usdMicros).toBeGreaterThan(0n);
    await pf.get('ETH');
    await pf.get('NEAR');
    expect(calls()).toBe(1);
  });
  test('falls back to CoinGecko when 1Click is down', async () => {
    const { pf } = feed({ oneClickDown: true });
    const eth = await pf.get('ETH');
    expect(eth).toMatchObject({ source: 'coingecko', usd: '2200.5', usdMicros: 2_200_500_000n });
  });
  test('clear error when every source fails', async () => {
    const { pf } = feed({ oneClickDown: true, geckoDown: true });
    await expect(pf.get('SOL')).rejects.toBeInstanceOf(PriceUnavailable);
  });
  test('a stale 1Click price is refused (falls back)', async () => {
    const { pf } = feed({ now: () => new Date(RECORDED_AT.getTime() + 60 * 60_000) });
    expect((await pf.get('SOL')).source).toBe('coingecko');
  });
  test('number -> micro-USD without float math on the result', () => {
    expect(usdNumberToMicros(90.1)).toBe(90_100_000n);
    expect(usdNumberToMicros(0.999531)).toBe(999_531n);
    expect(usdNumberToMicros(3.7)).toBe(3_700_000n);
    expect(microsToUsd(2_237_620_000n)).toBe('2237.62');
    expect(() => usdNumberToMicros(0)).toThrow();
    expect(() => usdNumberToMicros(0.0000009)).toThrow(); // truncates to 0, never rounds up
    expect(usdNumberToMicros(0.0000019)).toBe(1n);
    expect(isInvestAsset('SOL')).toBe(true);
    expect(isInvestAsset('DOGE')).toBe(false);
  });
});
