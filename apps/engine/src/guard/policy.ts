import {
  formatUsd,
  type MoneyPlan,
  planAmount,
  planRecipient,
  toBaseUnits,
  toMicros,
} from '@penny/shared';

/**
 * Guard: pure policy functions. No I/O, no clock reads (now is passed in),
 * no model. The model never gets a vote here.
 */

export type GuardDecision = 'allow_with_approval' | 'block' | 'needs_more_info';

export type GuardResult = {
  decision: GuardDecision;
  reasons: string[]; // plain English, safe to show the user
  amountMicrosUsd: bigint;
};

export type GuardPolicy = {
  perTxUsd: string;
  dailyUsd: string;
  allowlist: readonly string[];
  blockNewRecipientsOverUsd: string;
  maxApprovalsPer10Min: number;
};

export const DEFAULT_POLICY: GuardPolicy = {
  perTxUsd: '50',
  dailyUsd: '100',
  allowlist: [],
  blockNewRecipientsOverUsd: '20',
  maxApprovalsPer10Min: 5,
};

export const ASSET_WHITELIST = ['USDC', 'NEAR'] as const;
export const QUOTE_MAX_TTL_MS = 120_000;
export const QUOTE_MIN_REMAINING_MS = 15_000;

export type BotCaps = {
  botSlug: string;
  canMoveMoney: boolean;
  perTxCap?: string;
  dailyCap?: string;
  /** what this bot already moved in the rolling 24h window, micro-USD */
  spentLast24hMicros: bigint;
};

export type GuardContext = {
  now: Date;
  /** sum of reserved + settled ledger entries in the rolling 24h window, micro-USD */
  spentLast24hMicros: bigint;
  /** recipients the user has successfully paid before */
  knownRecipients: ReadonlySet<string>;
  /** approvals created in the last 10 minutes */
  approvalsLast10Min: number;
  /** USD price of 1 NEAR in micro-USD, required for NEAR sends */
  nearUsdPriceMicros?: bigint;
  /** quote attached to an invest plan */
  quote?: { id: string; expiresAt: Date };
  assetWhitelist?: readonly string[];
  bot?: BotCaps;
};

function usdMicros(plan: MoneyPlan, ctx: GuardContext): bigint | null {
  const { asset, amount } = planAmount(plan);
  if (asset === 'USDC') return toMicros(amount);
  if (ctx.nearUsdPriceMicros === undefined || ctx.nearUsdPriceMicros <= 0n) return null;
  // amount NEAR (24dp) * price (micro-USD per NEAR) / 1e24, rounded up (be conservative)
  const yocto = toBaseUnits(amount, 24);
  const num = yocto * ctx.nearUsdPriceMicros;
  const den = 10n ** 24n;
  return (num + den - 1n) / den;
}

export function evaluate(plan: MoneyPlan, policy: GuardPolicy, ctx: GuardContext): GuardResult {
  const block: string[] = [];
  const info: string[] = [];
  const notes: string[] = [];

  const whitelist = ctx.assetWhitelist ?? ASSET_WHITELIST;
  const { asset } = planAmount(plan);
  if (!whitelist.includes(asset)) {
    block.push(`${asset} isn't on the list of assets I'm allowed to move.`);
  }

  const amount = usdMicros(plan, ctx);
  if (amount === null) {
    // The amount cannot be sized in USD, so the caps cannot be checked. But a plan
    // that is already blocked for another reason must report `block`, not
    // `needs_more_info`, or the audit row and the mood event both lie about it.
    if (block.length > 0) return { decision: 'block', reasons: block, amountMicrosUsd: 0n };
    // One case is still decidable without a price: a NEAR amount so large that no
    // plausible price could bring it under the per-tx cap. Refuse it rather than
    // asking for a quote it can never pass. The floor is 1 NEAR >= $1, so the whole
    // NEAR count is a lower bound on the USD value; compare it to the cap in dollars
    // (perTx is micro-USD, hence the 1e6). The real price check still runs when a
    // price is available.
    if (planAmount(plan).asset === 'NEAR') {
      const perTxMicros = toMicros(policy.perTxUsd);
      const wholeNear = toBaseUnits(planAmount(plan).amount, 24) / 10n ** 24n;
      if (wholeNear * 1_000_000n > perTxMicros) {
        block.push(
          `That's more NEAR than your ${formatUsd(perTxMicros)} per-payment limit could cover.`,
        );
        return { decision: 'block', reasons: block, amountMicrosUsd: 0n };
      }
    }
    info.push("I need a fresh NEAR price before I can size this. I'll grab one.");
    return { decision: 'needs_more_info', reasons: info, amountMicrosUsd: 0n };
  }
  if (amount <= 0n) block.push('The amount has to be more than zero.');

  const perTx = toMicros(policy.perTxUsd);
  if (amount > perTx) {
    block.push(`That's ${formatUsd(amount)}, over your ${formatUsd(perTx)} per-payment limit.`);
  }

  const daily = toMicros(policy.dailyUsd);
  const after = ctx.spentLast24hMicros + amount;
  if (after > daily) {
    const left = daily > ctx.spentLast24hMicros ? daily - ctx.spentLast24hMicros : 0n;
    block.push(
      `That would take you past your ${formatUsd(daily)} daily limit. You have ${formatUsd(left)} left for the next 24 hours.`,
    );
  }

  if (ctx.approvalsLast10Min >= policy.maxApprovalsPer10Min) {
    block.push(
      `That's a lot of payments in 10 minutes (${ctx.approvalsLast10Min}). Let's slow down and try again shortly.`,
    );
  }

  const recipient = planRecipient(plan);
  if (recipient !== null) {
    const allowlisted = policy.allowlist.includes(recipient);
    const known = ctx.knownRecipients.has(recipient);
    if (!allowlisted && !known) {
      const threshold = toMicros(policy.blockNewRecipientsOverUsd);
      if (amount > threshold) {
        block.push(
          `You've never paid ${recipient} before. First payments to someone new are capped at ${formatUsd(threshold)}.`,
        );
      } else {
        notes.push(`First time paying ${recipient}. Double-check the name on the card.`);
      }
    }
  }

  if (plan.kind === 'invest') {
    const q = ctx.quote;
    if (!q || q.id !== plan.quoteId) {
      info.push("I don't have a live quote for this yet. I'll fetch one.");
    } else {
      const remaining = q.expiresAt.getTime() - ctx.now.getTime();
      if (remaining <= 0) block.push('That quote went stale. Prices move, so I need a new one.');
      else if (remaining > QUOTE_MAX_TTL_MS)
        block.push("That quote is valid for too long to be trusted. I'll get a tighter one.");
      else if (remaining < QUOTE_MIN_REMAINING_MS)
        info.push("That quote is about to expire. I'll refresh it so you have time to tap.");
    }
  }

  if (ctx.bot) {
    const b = ctx.bot;
    if (!b.canMoveMoney) {
      block.push(`${b.botSlug} isn't allowed to move money.`);
    } else {
      if (!b.perTxCap || !b.dailyCap) {
        block.push(`${b.botSlug} has no spending cap set, so it can't move money.`);
      } else {
        const bTx = toMicros(b.perTxCap);
        const bDay = toMicros(b.dailyCap);
        if (amount > bTx)
          block.push(`That's over ${b.botSlug}'s ${formatUsd(bTx)} per-payment cap.`);
        if (b.spentLast24hMicros + amount > bDay)
          block.push(`That would push ${b.botSlug} past its ${formatUsd(bDay)} daily cap.`);
      }
    }
  }

  if (block.length > 0) return { decision: 'block', reasons: block, amountMicrosUsd: amount };
  if (info.length > 0)
    return { decision: 'needs_more_info', reasons: info, amountMicrosUsd: amount };
  const left = daily - after;
  return {
    decision: 'allow_with_approval',
    reasons: [
      ...notes,
      `Needs your Face ID. ${formatUsd(left)} of ${formatUsd(daily)} left today after this.`,
    ],
    amountMicrosUsd: amount,
  };
}
