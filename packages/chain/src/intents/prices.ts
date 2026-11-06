import { z } from 'zod';
import { type FetchLike, fetchJson } from '../util/http.ts';
import type { OneClickClient, OneClickToken } from './oneclick.ts';

/** What Invest can buy today, and the 1Click asset each one maps to. */
export const INVEST_ASSETS = {
  ETH: { assetId: 'nep141:eth.omft.near', decimals: 18, coingeckoId: 'ethereum', name: 'Ether' },
  SOL: { assetId: 'nep141:sol.omft.near', decimals: 9, coingeckoId: 'solana', name: 'Solana' },
  NEAR: { assetId: 'nep141:wrap.near', decimals: 24, coingeckoId: 'near', name: 'NEAR' },
} as const;
export type InvestAsset = keyof typeof INVEST_ASSETS;
export const INVEST_ASSET_LIST = Object.keys(INVEST_ASSETS) as InvestAsset[];

export function isInvestAsset(s: string): s is InvestAsset {
  return Object.hasOwn(INVEST_ASSETS, s);
}

export type Price = {
  asset: InvestAsset;
  /** micro-USD per 1 whole unit, bigint */
  usdMicros: bigint;
  /** display string, up to 6 dp */
  usd: string;
  updatedAt: Date;
  source: 'near-intents' | 'coingecko';
};

export class PriceUnavailable extends Error {
  override name = 'PriceUnavailable';
}

/**
 * JSON number -> micro-USD bigint without float arithmetic on the result.
 * Prices arrive as JSON numbers; we read their shortest decimal form and truncate to 6 dp.
 */
export function usdNumberToMicros(n: number): bigint {
  if (!Number.isFinite(n) || n <= 0) throw new PriceUnavailable(`bad price ${n}`);
  const s = n >= 1e21 || n < 1e-6 ? n.toFixed(6) : String(n);
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new PriceUnavailable(`bad price ${n}`);
  const frac = ((m[2] ?? '') + '000000').slice(0, 6);
  return BigInt(m[1] as string) * 1_000_000n + BigInt(frac);
}

export function microsToUsd(m: bigint): string {
  const whole = m / 1_000_000n;
  const frac = (m % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}

const CoinGecko = z.record(z.string(), z.object({ usd: z.number() }));

export interface PriceFeedOptions {
  oneClick: OneClickClient;
  /** Public fallback; no key. Set to null to disable. */
  fallbackUrl?: string | null;
  fetch?: FetchLike;
  /** Cache lifetime. Default 60 s. */
  ttlMs?: number;
  /** A price older than this is refused (stale upstream). Default 15 min. */
  maxAgeMs?: number;
  timeoutMs?: number;
  now?: () => Date;
}

/**
 * ETH / SOL / NEAR spot prices. Primary: 1Click /v0/tokens (same prices 1Click quotes from).
 * Fallback: CoinGecko simple price (public, no key). Cached, with timeout and a clear error.
 */
export class PriceFeed {
  private cache: { at: number; prices: Map<InvestAsset, Price> } | null = null;
  private inflight: Promise<Map<InvestAsset, Price>> | null = null;
  private readonly now: () => Date;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly o: PriceFeedOptions) {
    this.now = o.now ?? (() => new Date());
    this.fetchImpl = o.fetch ?? ((i, init) => fetch(i, init));
  }

  async all(): Promise<Map<InvestAsset, Price>> {
    const t = this.now().getTime();
    if (this.cache && t - this.cache.at < (this.o.ttlMs ?? 60_000)) return this.cache.prices;
    if (!this.inflight) {
      this.inflight = this.load().finally(() => {
        this.inflight = null;
      });
    }
    const prices = await this.inflight;
    this.cache = { at: t, prices };
    return prices;
  }

  async get(asset: InvestAsset): Promise<Price> {
    const p = (await this.all()).get(asset);
    if (!p) throw new PriceUnavailable(`no price for ${asset}`);
    return p;
  }

  private async load(): Promise<Map<InvestAsset, Price>> {
    let firstErr: unknown;
    try {
      return this.fromTokens(await this.o.oneClick.getTokens());
    } catch (e) {
      firstErr = e;
    }
    if (this.o.fallbackUrl !== null) {
      try {
        return await this.fromCoinGecko();
      } catch (e) {
        throw new PriceUnavailable(
          `prices unavailable: 1Click (${(firstErr as Error).message}); fallback (${(e as Error).message})`,
        );
      }
    }
    throw new PriceUnavailable(`prices unavailable: 1Click (${(firstErr as Error).message})`);
  }

  private fromTokens(tokens: OneClickToken[]): Map<InvestAsset, Price> {
    const out = new Map<InvestAsset, Price>();
    const maxAge = this.o.maxAgeMs ?? 15 * 60_000;
    const t = this.now().getTime();
    for (const a of INVEST_ASSET_LIST) {
      const tok = tokens.find((x) => x.assetId === INVEST_ASSETS[a].assetId);
      if (!tok) throw new PriceUnavailable(`1Click has no token ${INVEST_ASSETS[a].assetId}`);
      const updatedAt = new Date(tok.priceUpdatedAt);
      if (t - updatedAt.getTime() > maxAge)
        throw new PriceUnavailable(`1Click price for ${a} is stale (${tok.priceUpdatedAt})`);
      const usdMicros = usdNumberToMicros(tok.price);
      out.set(a, { asset: a, usdMicros, usd: microsToUsd(usdMicros), updatedAt, source: 'near-intents' });
    }
    return out;
  }

  private async fromCoinGecko(): Promise<Map<InvestAsset, Price>> {
    const ids = INVEST_ASSET_LIST.map((a) => INVEST_ASSETS[a].coingeckoId).join(',');
    const base = this.o.fallbackUrl ?? 'https://api.coingecko.com/api/v3/simple/price';
    const r = await fetchJson(this.fetchImpl, `${base}?ids=${ids}&vs_currencies=usd`, CoinGecko, {
      timeoutMs: this.o.timeoutMs ?? 5_000,
    });
    const out = new Map<InvestAsset, Price>();
    for (const a of INVEST_ASSET_LIST) {
      const v = r[INVEST_ASSETS[a].coingeckoId];
      if (!v) throw new PriceUnavailable(`fallback has no price for ${a}`);
      const usdMicros = usdNumberToMicros(v.usd);
      out.set(a, { asset: a, usdMicros, usd: microsToUsd(usdMicros), updatedAt: this.now(), source: 'coingecko' });
    }
    return out;
  }
}
