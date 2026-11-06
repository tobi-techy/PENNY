import { toBaseUnits } from '@penny/shared';

/**
 * Invest = swap USDC on NEAR into ETH, SOL or NEAR through NEAR Intents 1Click.
 * The bought asset lands in the user's own intents.near balance (recipientType INTENTS,
 * recipient = the user's NEAR account). Refunds go back to the user's NEAR account.
 */
export const INVEST_ASSETS = ['ETH', 'SOL', 'NEAR'] as const;
export type InvestAsset = (typeof INVEST_ASSETS)[number];
export function isInvestAsset(s: string): s is InvestAsset {
  return (INVEST_ASSETS as readonly string[]).includes(s);
}

export type InvestQuote = {
  quoteId: string;
  asset: InvestAsset;
  amountUsd: string;
  userAccountId: string;
  /** USDC base units in */
  amountIn: bigint;
  /** destination base units, estimated and guaranteed minimum */
  amountOut: bigint;
  minAmountOut: bigint;
  decimalsOut: number;
  /** display strings, e.g. "0.011066 SOL", "1 SOL ≈ $90.36" */
  amountOutDisplay: string;
  minOutDisplay: string;
  rateDisplay: string;
  slippageBps: number;
  /** partner/app fee 1Click put on the quote, in bps (20 = 0.2% keyless fee) */
  feeBps: number;
  feeUsd: string;
  /** true when no ONECLICK_API_KEY / ONECLICK_JWT is set (1Click adds 0.2%) */
  keyless: boolean;
  /** present on firm (non-dry) quotes only */
  depositAddress?: string;
  expiresAt: Date;
  dry: boolean;
};

/** 1Click swap states, collapsed to what the card shows. */
export type SwapState = 'pending' | 'processing' | 'success' | 'refunded' | 'failed';

export type SwapStatusView = {
  state: SwapState;
  raw: string;
  /** e.g. "0.011066 SOL" when the swap reports it */
  amountOutDisplay?: string;
  refundReason?: string;
};

export interface InvestPort {
  /** Dry quote for the preview. No deposit address; nothing can be signed from it. */
  preview(asset: InvestAsset, amountUsd: string, userAccountId: string): Promise<InvestQuote>;
  /**
   * Firm (non-dry) quote with a deposit address, registered so chain.buildActions can
   * build the deposit for plan.quoteId. A non-dry quote moves no money.
   */
  firm(asset: InvestAsset, amountUsd: string, userAccountId: string): Promise<InvestQuote>;
  get(quoteId: string): InvestQuote | undefined;
  /**
   * Re-price an approved quote right before relay. price_moved when the fresh estimate
   * is below the approved quote's guaranteed minimum (i.e. beyond slippage).
   */
  recheck(
    q: InvestQuote,
  ): Promise<
    { ok: true; freshOut: bigint } | { ok: false; reason: 'price_moved'; freshOut: bigint }
  >;
  status(depositAddress: string): Promise<SwapStatusView>;
  /** Optional hint to 1Click that the deposit tx went out. Best effort. */
  notifyDeposit(p: { txHash: string; depositAddress: string; sender: string }): Promise<void>;
}

export function mapSwapStatus(raw: string): SwapState {
  switch (raw) {
    case 'PROCESSING':
      return 'processing';
    case 'SUCCESS':
      return 'success';
    case 'REFUNDED':
      return 'refunded';
    case 'FAILED':
      return 'failed';
    default:
      // KNOWN_DEPOSIT_TX, PENDING_DEPOSIT, INCOMPLETE_DEPOSIT
      return 'pending';
  }
}

/** base units -> "0.011066" (truncated to `dp` places, bigint only) */
export function formatUnits(v: bigint, decimals: number, dp = 6): string {
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const fracFull = (v % base).toString().padStart(decimals, '0');
  const frac = fracFull.slice(0, Math.min(dp, decimals)).replace(/0+$/, '');
  if (whole === 0n && frac === '' && v > 0n) {
    // keep tiny amounts visible: two significant digits
    const idx = fracFull.search(/[1-9]/);
    return `0.${fracFull.slice(0, idx + 2).replace(/0+$/, '')}`;
  }
  return frac ? `${whole}.${frac}` : whole.toString();
}

/** Scripted market for tests and offline dev. Deposit addresses are fake; FakeChain builds from them. */
export class FakeInvest implements InvestPort {
  private book = new Map<string, InvestQuote>();
  private seq = 0;
  /** price per whole unit in micro-USD; tests move it */
  prices: Record<InvestAsset, bigint> = {
    ETH: 2_000_000_000n,
    SOL: 100_000_000n,
    NEAR: 4_000_000n,
  };
  statuses = new Map<string, string>();
  notified: { txHash: string; depositAddress: string; sender: string }[] = [];
  firmCalls = 0;
  failNext: Error | null = null;

  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly onFirm?: (quoteId: string, depositAddress: string) => void,
  ) {}

  private quote(asset: InvestAsset, amountUsd: string, user: string, dry: boolean): InvestQuote {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
    const dec = asset === 'ETH' ? 18 : asset === 'SOL' ? 9 : 24;
    const amountIn = toBaseUnits(amountUsd, 6);
    // out = in(micro-USD) * 10^dec / price, minus 0.2% fee
    const gross = (amountIn * 10n ** BigInt(dec)) / this.prices[asset];
    const amountOut = (gross * 9980n) / 10_000n;
    const minAmountOut = (amountOut * 9900n) / 10_000n;
    this.seq += 1;
    const quoteId = `q_fake_${asset.toLowerCase()}_${this.seq}`;
    const q: InvestQuote = {
      quoteId,
      asset,
      amountUsd,
      userAccountId: user,
      amountIn,
      amountOut,
      minAmountOut,
      decimalsOut: dec,
      amountOutDisplay: `${formatUnits(amountOut, dec)} ${asset}`,
      minOutDisplay: `${formatUnits(minAmountOut, dec)} ${asset}`,
      rateDisplay: `1 ${asset} ≈ $${formatUnits(this.prices[asset], 6, 2)}`,
      slippageBps: 100,
      feeBps: 20,
      feeUsd: formatUnits((amountIn * 20n) / 10_000n, 6, 2),
      keyless: true,
      ...(dry ? {} : { depositAddress: `${'d'.repeat(56)}${String(this.seq).padStart(8, '0')}` }),
      expiresAt: new Date(this.now().getTime() + 120_000),
      dry,
    };
    this.book.set(quoteId, q);
    return q;
  }

  async preview(asset: InvestAsset, amountUsd: string, user: string) {
    return this.quote(asset, amountUsd, user, true);
  }
  async firm(asset: InvestAsset, amountUsd: string, user: string) {
    this.firmCalls += 1;
    const q = this.quote(asset, amountUsd, user, false);
    if (q.depositAddress) this.onFirm?.(q.quoteId, q.depositAddress);
    return q;
  }
  get(id: string) {
    return this.book.get(id);
  }
  async recheck(q: InvestQuote) {
    const fresh = this.quote(q.asset, q.amountUsd, q.userAccountId, true);
    return fresh.amountOut < q.minAmountOut
      ? { ok: false as const, reason: 'price_moved' as const, freshOut: fresh.amountOut }
      : { ok: true as const, freshOut: fresh.amountOut };
  }
  async status(depositAddress: string): Promise<SwapStatusView> {
    const raw = this.statuses.get(depositAddress) ?? 'PENDING_DEPOSIT';
    return { state: mapSwapStatus(raw), raw };
  }
  async notifyDeposit(p: { txHash: string; depositAddress: string; sender: string }) {
    this.notified.push(p);
  }
}
