import type { QuoteResponse, ValidatedQuote } from '@penny/chain';
import { eq, lt } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { investQuotes } from '../db/schema.ts';
import { formatUnits, type InvestQuote, isInvestAsset } from '../market/invest.ts';

/**
 * Firm invest quotes, durable. The engine's InvestPort reads one back after a
 * restart; the chain adapter rebuilds its cached ValidatedQuote from the same
 * row, so buildActions still knows the deposit address the card was made for.
 */
export class InvestQuotesRepo {
  constructor(private readonly db: Db) {}

  async save(q: InvestQuote, v: ValidatedQuote): Promise<void> {
    const row = {
      quoteId: q.quoteId,
      asset: q.asset,
      amountUsd: q.amountUsd,
      userAccountId: q.userAccountId,
      amountIn: q.amountIn.toString(),
      amountOut: q.amountOut.toString(),
      minAmountOut: q.minAmountOut.toString(),
      decimalsOut: q.decimalsOut,
      slippageBps: q.slippageBps,
      feeBps: q.feeBps,
      feeUsd: q.feeUsd,
      keyless: q.keyless,
      depositAddress: q.depositAddress ?? null,
      depositMemo: v.depositMemo ?? null,
      expiresAt: q.expiresAt,
      response: v.response,
    };
    await this.db
      .insert(investQuotes)
      .values(row)
      .onConflictDoUpdate({ target: investQuotes.quoteId, set: row });
  }

  /** The engine's view of a stored quote, or null when it is unknown. */
  async get(quoteId: string): Promise<InvestQuote | null> {
    const [r] = await this.db
      .select()
      .from(investQuotes)
      .where(eq(investQuotes.quoteId, quoteId))
      .limit(1);
    if (!r || !isInvestAsset(r.asset)) return null;
    const amountOut = BigInt(r.amountOut);
    const minAmountOut = BigInt(r.minAmountOut);
    // The rate the card showed: dollars paid per whole unit received, fees included.
    const rateMicros =
      amountOut > 0n ? (BigInt(r.amountIn) * 10n ** BigInt(r.decimalsOut)) / amountOut : 0n;
    return {
      quoteId: r.quoteId,
      asset: r.asset,
      amountUsd: r.amountUsd,
      userAccountId: r.userAccountId,
      amountIn: BigInt(r.amountIn),
      amountOut,
      minAmountOut,
      decimalsOut: r.decimalsOut,
      amountOutDisplay: `${formatUnits(amountOut, r.decimalsOut)} ${r.asset}`,
      minOutDisplay: `${formatUnits(minAmountOut, r.decimalsOut)} ${r.asset}`,
      rateDisplay: `1 ${r.asset} ≈ $${formatUnits(rateMicros, 6, 2)}`,
      slippageBps: r.slippageBps,
      feeBps: r.feeBps,
      feeUsd: r.feeUsd,
      keyless: r.keyless,
      ...(r.depositAddress ? { depositAddress: r.depositAddress } : {}),
      expiresAt: r.expiresAt,
      dry: false,
    };
  }

  /** The chain adapter's view: the same row, rebuilt as a ValidatedQuote. */
  async validated(quoteId: string): Promise<ValidatedQuote | null> {
    const [r] = await this.db
      .select()
      .from(investQuotes)
      .where(eq(investQuotes.quoteId, quoteId))
      .limit(1);
    if (!r) return null;
    return {
      response: r.response as QuoteResponse,
      amountIn: BigInt(r.amountIn),
      amountOut: BigInt(r.amountOut),
      minAmountOut: BigInt(r.minAmountOut),
      ...(r.depositAddress ? { depositAddress: r.depositAddress } : {}),
      ...(r.depositMemo ? { depositMemo: r.depositMemo } : {}),
      expiresAt: r.expiresAt,
    };
  }

  /** Drop quotes that expired long enough ago that no card can still point at them. */
  async prune(before: Date): Promise<void> {
    await this.db.delete(investQuotes).where(lt(investQuotes.expiresAt, before));
  }
}
