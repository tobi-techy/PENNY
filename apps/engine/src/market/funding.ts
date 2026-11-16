import { fromMicros, toMicros } from '@penny/shared';
import type { SwapState } from './invest.ts';

/**
 * Getting dollars into Penny from another chain, through NEAR Intents 1Click.
 * The user sends USDC on their chain to a deposit address; 1Click delivers USDC
 * to their own NEAR account. Nothing here can spend: the address only receives.
 */

export const FUND_CHAINS = ['base', 'ethereum', 'arbitrum', 'solana'] as const;
export type FundChain = (typeof FUND_CHAINS)[number];

export const FUND_CHAIN_LABEL: Record<FundChain, string> = {
  base: 'Base',
  ethereum: 'Ethereum',
  arbitrum: 'Arbitrum',
  solana: 'Solana',
};

export function isFundChain(s: string): s is FundChain {
  return (FUND_CHAINS as readonly string[]).includes(s);
}

export type FundingQuote = {
  chain: FundChain;
  /** Where the user sends USDC. Only ever receives. */
  depositAddress: string;
  /** Some chains need a memo with the transfer (1Click returns one when so). */
  depositMemo?: string;
  amountUsd: string;
  /** Origin base units (USDC is 6 dp on every supported chain). */
  amountIn: bigint;
  /** Guaranteed minimum landing, e.g. "19.80 USDC". */
  minOutDisplay: string;
  /** How long the address stays usable. */
  expiresAt: Date;
};

export type FundingStatus = {
  state: SwapState;
  /** What actually landed, when the swap reports it. */
  amountOutDisplay?: string;
  raw: string;
};

export interface FundingPort {
  /** Chains this deployment can quote right now (a live 1Click token list). */
  chains(): Promise<FundChain[]>;
  quote(chain: FundChain, amountUsd: string, userAccountId: string): Promise<FundingQuote>;
  status(depositAddress: string): Promise<FundingStatus>;
}

/** Scripted funding for tests and offline dev. Nothing talks to a chain. */
export class FakeFunding implements FundingPort {
  private seq = 0;
  readonly statuses = new Map<string, string>();
  readonly quotes: FundingQuote[] = [];
  /** Chains offered by `chains()`; tests narrow it. */
  available: FundChain[] = [...FUND_CHAINS];
  failNext: Error | null = null;

  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly ttlMs = 60 * 60_000,
  ) {}

  async chains(): Promise<FundChain[]> {
    return [...this.available];
  }

  async quote(chain: FundChain, amountUsd: string, _user: string): Promise<FundingQuote> {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
    this.seq += 1;
    const micros = toMicros(amountUsd);
    const q: FundingQuote = {
      chain,
      depositAddress: `deposit-${chain}-${this.seq}`,
      amountUsd,
      amountIn: micros,
      minOutDisplay: `${fromMicros((micros * 99n) / 100n)} USDC`,
      expiresAt: new Date(this.now().getTime() + this.ttlMs),
    };
    this.quotes.push(q);
    return q;
  }

  async status(depositAddress: string): Promise<FundingStatus> {
    const raw = this.statuses.get(depositAddress) ?? 'PENDING_DEPOSIT';
    const state =
      raw === 'SUCCESS'
        ? ('success' as const)
        : raw === 'REFUNDED'
          ? ('refunded' as const)
          : raw === 'FAILED'
            ? ('failed' as const)
            : raw === 'PROCESSING'
              ? ('processing' as const)
              : ('pending' as const);
    return {
      state,
      raw,
      ...(state === 'success' ? { amountOutDisplay: '19.94 USDC' } : {}),
    };
  }
}
