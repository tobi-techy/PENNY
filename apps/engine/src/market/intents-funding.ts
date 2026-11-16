import { type ChainAdapter, USDC_ASSET_ID, USDC_DECIMALS } from '@penny/chain';
import { toBaseUnits } from '@penny/shared';
import {
  FUND_CHAIN_LABEL,
  FUND_CHAINS,
  type FundChain,
  type FundingPort,
  type FundingQuote,
  type FundingStatus,
} from './funding.ts';
import { formatUnits, mapSwapStatus } from './invest.ts';

/**
 * USDC on each origin chain, as 1Click names it. An entry is offered only when
 * the live /v0/tokens list also carries it, so a chain whose asset id changed
 * quietly disappears instead of sending someone to a dead address.
 */
export const FUND_ASSETS: Record<FundChain, string> = {
  // USDC on Base
  base: 'erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  // USDC on Ethereum
  ethereum: 'erc20:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  // USDC on Arbitrum One
  arbitrum: 'erc20:0xaf88d065e77c8cc2239327c5edb3a432268e5831',
  // USDC on Solana
  solana: 'sol:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
};

/** Long enough for a person to open their exchange and send. 1Click decides the real deadline. */
export const FUNDING_DEADLINE_MS = 60 * 60_000;
/** Slack on the 0.1%: a deposit is a transfer, not a price trade. */
export const FUNDING_SLIPPAGE_BPS = 10;
const TOKENS_TTL_MS = 10 * 60_000;

export class IntentsFunding implements FundingPort {
  private tokenCache: { at: number; chains: FundChain[] } | null = null;
  private readonly now: () => Date;

  constructor(
    private readonly d: {
      adapter: ChainAdapter;
      now?: () => Date;
      deadlineMs?: number;
    },
  ) {
    this.now = d.now ?? (() => new Date());
  }

  /**
   * Chains 1Click will quote for USDC right now. Cached briefly: the list is
   * public and changes rarely, and this runs on a card path.
   */
  async chains(): Promise<FundChain[]> {
    const t = this.now().getTime();
    if (this.tokenCache && t - this.tokenCache.at < TOKENS_TTL_MS) return this.tokenCache.chains;
    const tokens = await this.d.adapter.oneClick.getTokens();
    const listed = new Set(tokens.map((x) => x.assetId.toLowerCase()));
    const chains = FUND_CHAINS.filter((c) => listed.has(FUND_ASSETS[c].toLowerCase()));
    this.tokenCache = { at: t, chains };
    return chains;
  }

  async quote(chain: FundChain, amountUsd: string, userAccountId: string): Promise<FundingQuote> {
    if (!(await this.chains()).includes(chain)) {
      throw new Error(`${FUND_CHAIN_LABEL[chain]} is not available right now`);
    }
    const now = this.now();
    const v = await this.d.adapter.oneClick.quote({
      dry: false,
      originAsset: FUND_ASSETS[chain],
      destinationAsset: USDC_ASSET_ID,
      amount: toBaseUnits(amountUsd, USDC_DECIMALS),
      slippageBps: FUNDING_SLIPPAGE_BPS,
      // The dollars land on their own NEAR account, so the engine can spend them.
      recipient: userAccountId,
      recipientType: 'DESTINATION_CHAIN',
      // An unfilled deposit refunds to their own intents balance, never to Penny.
      refundTo: userAccountId,
      refundType: 'INTENTS',
      depositType: 'ORIGIN_CHAIN',
      deadline: new Date(now.getTime() + (this.d.deadlineMs ?? FUNDING_DEADLINE_MS)),
    });
    if (!v.depositAddress) throw new Error('funding quote without a deposit address');
    // A funding address must outlive the 120 s approval cap; take 1Click's own
    // deadline (the approval TTL does not apply: nothing is signed here).
    const deadline = v.response.quote.deadline;
    const expiresAt = deadline ? new Date(deadline) : new Date(now.getTime() + FUNDING_DEADLINE_MS);
    if (expiresAt.getTime() <= now.getTime()) throw new Error('funding quote already expired');
    return {
      chain,
      depositAddress: v.depositAddress,
      ...(v.depositMemo ? { depositMemo: v.depositMemo } : {}),
      amountUsd,
      amountIn: v.amountIn,
      minOutDisplay: `${formatUnits(v.minAmountOut, USDC_DECIMALS)} USDC`,
      expiresAt,
    };
  }

  async status(depositAddress: string): Promise<FundingStatus> {
    const s = await this.d.adapter.oneClick.status(depositAddress);
    const d = s.swapDetails;
    return {
      state: mapSwapStatus(s.status),
      raw: s.status,
      ...(d.amountOutFormatted ? { amountOutDisplay: `${d.amountOutFormatted} USDC` } : {}),
    };
  }
}
