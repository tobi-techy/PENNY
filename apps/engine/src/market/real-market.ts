import {
  INVEST_ASSETS as CHAIN_ASSETS,
  type ChainAdapter,
  type PriceFeed,
  PriceUnavailable,
} from '@penny/chain';
import type { MarketPort } from '../brain/registry.ts';
import { formatUnits, INVEST_ASSETS } from './invest.ts';

/** NEAR Intents verifier: holds what Invest bought, per user account (multi-token balances). */
const INTENTS_CONTRACT = 'intents.near';

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
    const out = [
      { asset: 'USDC', amount: b.usdc.display },
      { asset: 'NEAR', amount: b.near.display },
    ];
    // What Invest bought sits in the user's own balance on intents.near; show it as holdings.
    try {
      const ids = INVEST_ASSETS.map((a) => CHAIN_ASSETS[a].assetId);
      const raw = await this.adapter.rpc.callView(INTENTS_CONTRACT, 'mt_batch_balance_of', {
        account_id: accountId,
        token_ids: ids,
      });
      if (Array.isArray(raw)) {
        INVEST_ASSETS.forEach((a, i) => {
          const v = raw[i];
          if (typeof v === 'string' && /^\d+$/.test(v) && v !== '0')
            out.push({
              asset: `${a} (invested)`,
              amount: formatUnits(BigInt(v), CHAIN_ASSETS[a].decimals),
            });
        });
      }
    } catch {
      // holdings unavailable: return wallet balances only
    }
    return out;
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
