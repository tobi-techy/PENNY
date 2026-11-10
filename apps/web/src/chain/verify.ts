/**
 * Check an approval before signing it, the way the iPhone does (LiveCard.swift):
 * recompute planHash over the plan and the exact NEAR actions, derive the four-field
 * action from the plan, recompute approvalHash, and refuse on any mismatch. The page
 * then shows the action it derived itself, so the passkey never covers bytes the
 * screen didn't describe.
 */
import { canonicalize } from '@penny/shared/canonical';
import { sha256, toBase64Url } from './encoding.ts';

export type ApprovalAction = { type: string; to: string; amount: string; asset: string };

type Plan = Record<string, unknown> & { kind: string };

/** Same mapping as packages/shared approvalActionOf (and Swift ApprovalIntent). */
export function actionOf(plan: Plan): ApprovalAction | null {
  const s = (k: string) => (typeof plan[k] === 'string' ? (plan[k] as string) : '');
  switch (plan.kind) {
    case 'send':
      return { type: 'send', to: s('to'), amount: s('amount'), asset: s('asset') };
    case 'invest':
      return { type: 'invest', to: s('portfolioId'), amount: s('amountUsd'), asset: 'USDC' };
    case 'pay_bill':
      return { type: 'pay_bill', to: s('payee'), amount: s('amount'), asset: s('asset') };
    case 'errand':
      return { type: 'errand', to: s('taskId'), amount: s('amount'), asset: s('asset') };
    case 'split':
      return { type: 'split', to: 'group', amount: s('total'), asset: 'USDC' };
    case 'create_bot': {
      const perms = (plan.permissions ?? {}) as { dailyCap?: unknown };
      return {
        type: 'create_bot',
        to: s('slug'),
        amount: typeof perms.dailyCap === 'string' ? perms.dailyCap : '0',
        asset: 'USDC',
      };
    }
    case 'write':
      return { type: 'write', to: `${s('toolkit')}:${s('toolSlug')}`, amount: '0', asset: 'none' };
    default:
      return null;
  }
}

async function hashB64(text: string): Promise<string> {
  return toBase64Url(await sha256(new TextEncoder().encode(text)));
}

export class ApprovalMismatch extends Error {
  override name = 'ApprovalMismatch';
}

/** Throws ApprovalMismatch unless the server's approval hangs together. Returns the action. */
export async function verifyApproval(a: {
  id: string;
  approvalHash: string;
  expiresAt: string;
  action?: ApprovalAction;
  detail: unknown;
}): Promise<ApprovalAction> {
  const d = a.detail as {
    id?: string;
    plan?: Plan;
    actions?: unknown[];
    planHash?: string;
    expiresAt?: string;
  } | null;
  if (!d?.plan || !Array.isArray(d.actions) || !d.planHash || d.id !== a.id)
    throw new ApprovalMismatch('incomplete approval');
  if ((await hashB64(canonicalize({ plan: d.plan, actions: d.actions }))) !== d.planHash)
    throw new ApprovalMismatch('plan hash');
  const action = actionOf(d.plan);
  if (!action) throw new ApprovalMismatch('unknown action');
  if (a.action && canonicalize(a.action) !== canonicalize(action))
    throw new ApprovalMismatch('action');
  const recomputed = await hashB64(
    canonicalize({ action, expiresAt: a.expiresAt, id: a.id, planHash: d.planHash }),
  );
  if (recomputed !== a.approvalHash) throw new ApprovalMismatch('approval hash');
  return action;
}

/** "Send 0.1 NEAR to amara.testnet" from the verified action. */
export function describeAction(x: ApprovalAction): string {
  switch (x.type) {
    case 'send':
      return `Send ${x.amount} ${x.asset} to ${x.to}`;
    case 'invest':
      return `Buy $${x.amount} of ${x.to}`;
    case 'pay_bill':
      return `Pay ${x.amount} ${x.asset} to ${x.to}`;
    case 'create_bot':
      return `Turn on the bot ${x.to}`;
    case 'write':
      return x.to === 'penny:PENNY_UNFREEZE' ? 'Unfreeze Penny' : `Act in ${x.to.split(':')[0]}`;
    default:
      return `${x.type} ${x.amount} ${x.asset} to ${x.to}`;
  }
}
