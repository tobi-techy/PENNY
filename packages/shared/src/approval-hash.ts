import { canonicalize } from './canonical.ts';
import { sha256Base64Url } from './encoding.ts';
import type { IntentPlan } from './schemas.ts';

/**
 * The action a person approves, in four fields. This is what the card shows and
 * what the approval hash commits to, next to the exact NEAR actions (via planHash).
 */
export type ApprovalAction = { type: string; to: string; amount: string; asset: string };

export function approvalActionOf(plan: IntentPlan): ApprovalAction {
  switch (plan.kind) {
    case 'send':
      return { type: 'send', to: plan.to, amount: plan.amount, asset: plan.asset };
    case 'invest':
      return { type: 'invest', to: plan.portfolioId, amount: plan.amountUsd, asset: 'USDC' };
    case 'pay_bill':
      return { type: 'pay_bill', to: plan.payee, amount: plan.amount, asset: plan.asset };
    case 'errand':
      return { type: 'errand', to: plan.taskId, amount: plan.amount, asset: plan.asset };
    case 'split':
      return { type: 'split', to: 'group', amount: plan.total, asset: 'USDC' };
    case 'create_bot':
      return {
        type: 'create_bot',
        to: plan.slug,
        amount: plan.permissions.dailyCap ?? '0',
        asset: 'USDC',
      };
    case 'write':
      return { type: 'write', to: `${plan.toolkit}:${plan.toolSlug}`, amount: '0', asset: 'none' };
  }
}

/**
 * approvalHash = base64url(sha256(JCS({ action, expiresAt, id, planHash })))
 *
 * `action` is the four-field action above, `expiresAt` the ISO-8601 string the
 * engine returns, `planHash` the existing hash over plan + exact NEAR actions.
 * Swift (PennyCore ApprovalHash) and the engine compute the same bytes; the
 * shared vector lives in test-vectors/09-approval-hash.json.
 */
export function approvalHashInput(a: {
  id: string;
  action: ApprovalAction;
  expiresAt: string;
  planHash: string;
}): string {
  return canonicalize({
    action: a.action,
    expiresAt: a.expiresAt,
    id: a.id,
    planHash: a.planHash,
  });
}

export function approvalHash(a: {
  id: string;
  action: ApprovalAction;
  expiresAt: string;
  planHash: string;
}): string {
  return sha256Base64Url(approvalHashInput(a));
}

/**
 * The message the device key signs to approve: approvalHash plus the single-use
 * challenge, with a domain prefix so it can never be mistaken for a NEAR payload.
 */
export function approvalSignMessage(approvalHashValue: string, challenge: string): string {
  return `penny-approval:v2:${approvalHashValue}:${challenge}`;
}

/**
 * The WebAuthn challenge for an approval (or unfreeze) passkey prompt:
 * base64url(sha256(UTF-8(message))). It binds the passkey to the exact action: the
 * browser computes it from the approval hash it checked itself, and the server
 * recomputes it from the stored hash. The single-use challenge inside keeps it fresh.
 */
export function passkeyChallengeFor(message: string): string {
  return sha256Base64Url(message);
}
