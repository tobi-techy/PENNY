import {
  INVEST_ASSETS as CHAIN_ASSETS,
  type ChainAdapter,
  quoteFeeBps,
  type ValidatedQuote,
} from '@penny/chain';
import { fromMicros, toMicros } from '@penny/shared';
import {
  formatUnits,
  type InvestAsset,
  type InvestPort,
  type InvestQuote,
  type InvestQuoteStore,
  mapSwapStatus,
  type SwapStatusView,
} from './invest.ts';

export type IntentsInvestOptions = {
  adapter: ChainAdapter;
  slippageBps?: number;
  now?: () => Date;
  /** Durable store for firm quotes, so a restart does not lose an open card's quote. */
  quotes?: InvestQuoteStore;
};

/** "0.997062547700" -> micro-USD, truncating past 6 dp. null when not a plain decimal. */
function usdToMicros(s: string): bigint | null {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s.trim());
  if (!m) return null;
  const frac = (m[2] ?? '').slice(0, 6);
  return toMicros(frac ? `${m[1]}.${frac}` : (m[1] as string));
}

/**
 * Real Invest through NEAR Intents 1Click. Preview = dry quote. Firm = non-dry quote
 * (deposit address, 120 s cap) cached in the ChainAdapter under its quoteId so
 * buildActions('invest') produces storage_deposit? + ft_transfer to the deposit address.
 */
export class IntentsInvest implements InvestPort {
  private book = new Map<string, InvestQuote>();
  private readonly now: () => Date;
  constructor(private readonly o: IntentsInvestOptions) {
    this.now = o.now ?? (() => new Date());
  }

  private params(asset: InvestAsset, amountUsd: string, user: string, dry: boolean) {
    return {
      amountUsd,
      destinationAsset: CHAIN_ASSETS[asset].assetId,
      recipient: user,
      recipientType: 'INTENTS' as const,
      userAccountId: user,
      slippageBps: this.o.slippageBps ?? 100,
      dry,
    };
  }

  private async toQuote(
    quoteId: string,
    asset: InvestAsset,
    amountUsd: string,
    user: string,
    v: ValidatedQuote,
  ): Promise<InvestQuote> {
    const dec = CHAIN_ASSETS[asset].decimals;
    const inUsd = usdToMicros(v.response.quote.amountInUsd);
    const outUsd = usdToMicros(v.response.quote.amountOutUsd);
    // rate: USD paid per whole unit received (what the user effectively pays, fees included)
    const rateMicros = v.amountOut > 0n ? (v.amountIn * 10n ** BigInt(dec)) / v.amountOut : 0n;
    const feeBps = quoteFeeBps(v.response);
    const feeMicros =
      inUsd !== null && outUsd !== null && inUsd > outUsd
        ? inUsd - outUsd
        : (v.amountIn * BigInt(feeBps)) / 10_000n;
    const q: InvestQuote = {
      quoteId,
      asset,
      amountUsd,
      userAccountId: user,
      amountIn: v.amountIn,
      amountOut: v.amountOut,
      minAmountOut: v.minAmountOut,
      decimalsOut: dec,
      amountOutDisplay: `${formatUnits(v.amountOut, dec)} ${asset}`,
      minOutDisplay: `${formatUnits(v.minAmountOut, dec)} ${asset}`,
      rateDisplay: `1 ${asset} ≈ $${formatUnits(rateMicros, 6, 2)}`,
      slippageBps: v.response.quoteRequest.slippageTolerance,
      feeBps,
      feeUsd: fromMicros(feeMicros),
      keyless: !this.o.adapter.oneClick.authenticated,
      ...(v.depositAddress ? { depositAddress: v.depositAddress } : {}),
      expiresAt: v.expiresAt,
      dry: v.response.quoteRequest.dry,
    };
    const t = this.now().getTime();
    for (const [k, x] of this.book)
      if (x.expiresAt.getTime() + 30 * 60_000 < t) this.book.delete(k);
    this.book.set(quoteId, q);
    return q;
  }

  async preview(asset: InvestAsset, amountUsd: string, user: string): Promise<InvestQuote> {
    const v = await this.o.adapter.quoteInvest(this.params(asset, amountUsd, user, true));
    return this.toQuote(`p_${v.response.correlationId}`.slice(0, 120), asset, amountUsd, user, v);
  }

  async firm(asset: InvestAsset, amountUsd: string, user: string): Promise<InvestQuote> {
    // quoteId is fixed before the call so the adapter caches the quote under it
    const quoteId = `q_${crypto.randomUUID()}`;
    const v = await this.o.adapter.quoteInvestForPlan({
      ...this.params(asset, amountUsd, user, false),
      quoteId,
    });
    if (!v.depositAddress) throw new Error('firm quote without deposit address');
    const q = await this.toQuote(quoteId, asset, amountUsd, user, v);
    // Persist before the card goes out: the tap may land on another process.
    await this.o.quotes?.save(q, v);
    return q;
  }

  async get(quoteId: string) {
    const cached = this.book.get(quoteId);
    if (cached) return cached;
    const stored = await this.o.quotes?.get(quoteId);
    if (!stored) return undefined;
    // Re-cache so the rest of the approval path sees the same object as a fresh quote.
    this.book.set(quoteId, stored);
    return stored;
  }

  async recheck(q: InvestQuote) {
    const v = await this.o.adapter.quoteInvest(
      this.params(q.asset, q.amountUsd, q.userAccountId, true),
    );
    return v.amountOut < q.minAmountOut
      ? { ok: false as const, reason: 'price_moved' as const, freshOut: v.amountOut }
      : { ok: true as const, freshOut: v.amountOut };
  }

  async status(depositAddress: string): Promise<SwapStatusView> {
    const s = await this.o.adapter.oneClick.status(depositAddress);
    const d = s.swapDetails;
    const asset = (Object.keys(CHAIN_ASSETS) as InvestAsset[]).find(
      (a) => CHAIN_ASSETS[a].assetId === s.quoteResponse.quoteRequest.destinationAsset,
    );
    return {
      state: mapSwapStatus(s.status),
      raw: s.status,
      ...(d.amountOutFormatted && asset
        ? { amountOutDisplay: `${d.amountOutFormatted} ${asset}` }
        : {}),
      ...(d.refundReason ? { refundReason: d.refundReason } : {}),
    };
  }

  async notifyDeposit(p: { txHash: string; depositAddress: string; sender: string }) {
    await this.o.adapter.oneClick.submitDeposit({
      txHash: p.txHash,
      depositAddress: p.depositAddress,
      nearSenderAccount: p.sender,
    });
  }
}
