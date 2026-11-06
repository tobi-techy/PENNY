import { type ChainAdapter, type PriceFeed, PriceUnavailable } from '@penny/chain';
import type { MarketPort } from '../brain/registry.ts';
import { INVEST_ASSETS } from './invest.ts';

const BLURB = {
  ETH: 'Ether. bought with your dollars.',
  SOL: 'Solana. bought with your dollars.',
  NEAR: 'NEAR. bought with your dollars.',
} as const;

/** Real read-only market data: balances from NEAR RPC, prices from 1Click (CoinGecko fallback). */
export class RealMarket implements MarketPort {
  constructor(
    private readonly adapter: ChainAdapter,
    private readonly prices: PriceFeed,
  ) {}

  async getBalances(accountId: string) {
    const b = await this.adapter.getBalances(accountId);
    return [
      { asset: 'USDC', amount: b.usdc.display },
      { asset: 'NEAR', amount: b.near.display },
    ];
  }

  async getPortfolios() {
    const all = await this.prices.all();
    return INVEST_ASSETS.map((a) => {
      const p = all.get(a);
      return {
        id: a,
        name: a,
        blurb: BLURB[a],
        ...(p ? { priceUsd: p.usd, priceSource: p.source } : {}),
      };
    });
  }

  async nearUsdPriceMicros(): Promise<bigint> {
    try {
      return (await this.prices.get('NEAR')).usdMicros;
    } catch (e) {
      if (e instanceof PriceUnavailable) throw e;
      throw new PriceUnavailable((e as Error).message);
    }
  }
}
