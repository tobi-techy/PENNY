import { type MoneyPlan, NearAccountId, planAmount, toMicros } from '@penny/shared';
import { z } from 'zod';

/**
 * The shared Guard contract (contracts/guard) as a second, fail-closed gate on
 * the spend path. Local Guard policy (`policy.ts`) is still the primary rule
 * set; when PENNY_GUARD_CONTRACT is configured, the owner's on-chain allowance
 * for the agent handling this move must also allow it, or nothing moves.
 *
 * This mirrors the policy preconditions of the contract's `spend` entry point:
 * paused_all, no policy, revoked, paused, expired, token, allowlist, per-tx and
 * daily caps. The contract's budget is not checked because the engine never
 * spends the owner's Guard budget (money still moves as a NEP-366 action signed
 * by the user's device).
 *
 * Pure: no I/O, no clock reads. The caller reads the views and passes them in.
 */

/** The on-chain policy view, parsed at the boundary (third-party response). */
export const OnChainPolicyView = z.object({
  owner_id: z.string().min(1).max(64),
  agent_id: z.string().min(1).max(64),
  limits: z
    .array(
      z.object({
        token: z.string().min(1).max(64),
        per_tx_cap: z.string().regex(/^\d+$/),
        daily_cap: z.string().regex(/^\d+$/),
      }),
    )
    .max(16),
  allowlist: z.array(z.string().min(1).max(64)).max(200),
  /** Unix nanoseconds as a string, or null for no expiry. */
  expires_at: z.string().regex(/^\d+$/).nullable(),
  paused: z.boolean(),
  revoked: z.boolean(),
  last_nonce: z.string().regex(/^\d+$/),
});
export type OnChainPolicyView = z.infer<typeof OnChainPolicyView>;

/** Shown when the contract cannot be read. Never implies a payment happened. */
export const GUARD_UNREADABLE = "I couldn't check your guard, so nothing moved.";

/**
 * Agent account that owns the allowance: the bot's sub-account under the app
 * account (e.g. invest.penny.near), or the app account itself for Penny.
 * Null when the slug would not make a valid NEAR account id.
 */
export function guardAgentId(slug: string | null | undefined, appAccountId: string): string | null {
  const id = !slug || slug === 'penny' ? appAccountId : `${slug}.${appAccountId}`;
  return NearAccountId.safeParse(id).success ? id : null;
}

/**
 * The NEAR account an agent spend would name as the recipient, when the plan has
 * a stable one. Invest and errand pay a quote/task destination that changes per
 * move, so they are capped but not allowlist-checked.
 */
export function onChainRecipient(plan: MoneyPlan): string | null {
  if (plan.kind === 'send') return plan.to;
  if (plan.kind === 'pay_bill') return plan.payee;
  return null;
}

export type OnChainGuardInput = {
  now: Date;
  contractId: string;
  agentAccountId: string;
  /** Plain name for user-facing copy: "Invest", "Penny". */
  agentName: string;
  /** The dollar token the shared Guard is allowed to move (from get_tokens). */
  token: string;
  pausedAll: boolean;
  policy: OnChainPolicyView | null;
  /** The owner's agent spend for the current UTC day, in token base units. */
  spentToday: string;
  plan: MoneyPlan;
};

/**
 * Plain-English reasons the shared Guard would refuse this move. Empty means it
 * allows it. Ordered from the cheapest check to the ones that need the amount.
 */
export function evaluateOnChainGuard(input: OnChainGuardInput): string[] {
  const { plan, policy, agentName } = input;
  if (input.pausedAll) {
    return ['Your guard is paused, so nothing can move.'];
  }
  if (!policy) {
    return [`Your guard has no allowance for ${agentName}, so nothing moved.`];
  }
  if (policy.revoked) {
    return [`${agentName}'s allowance was revoked, so nothing moved.`];
  }
  if (policy.paused) {
    return [`${agentName}'s allowance is paused, so nothing moved.`];
  }
  if (
    policy.expires_at !== null &&
    BigInt(policy.expires_at) <= BigInt(input.now.getTime()) * 1_000_000n
  ) {
    return [`${agentName}'s allowance ran out, so nothing moved.`];
  }

  const { asset, amount } = planAmount(plan);
  if (asset !== 'USDC') {
    return ["Your guard only covers dollar payments, so I can't clear a NEAR send right now."];
  }
  const limit = policy.limits.find((l) => l.token === input.token);
  if (!limit) {
    return [`Your guard doesn't allow dollar payments from ${agentName} right now.`];
  }

  let micros: bigint;
  let spent: bigint;
  let perTx: bigint;
  let daily: bigint;
  try {
    micros = toMicros(amount);
    spent = BigInt(input.spentToday);
    perTx = BigInt(limit.per_tx_cap);
    daily = BigInt(limit.daily_cap);
  } catch {
    return [GUARD_UNREADABLE];
  }
  if (micros > perTx) {
    return [`That's over the per-payment limit on your guard.`];
  }
  if (spent + micros > daily) {
    return [`That would take you past the daily limit on your guard.`];
  }

  const recipient = onChainRecipient(plan);
  if (recipient !== null) {
    // contracts/guard never lets an agent pay the contract or itself.
    if (recipient === input.contractId || recipient === input.agentAccountId) {
      return ["That recipient isn't one your guard allows."];
    }
    if (policy.allowlist.length > 0 && !policy.allowlist.includes(recipient)) {
      return ["That recipient isn't on the list your guard allows."];
    }
  }
  return [];
}
