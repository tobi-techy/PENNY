/**
 * The browser checks an approval before it signs anything, like the iPhone app does
 * (PennyCore ApprovalTicket). It never trusts the server's hash or wording:
 *   - planHash is recomputed from the exact plan + NEAR actions it will sign,
 *   - the four-field action is derived from that plan,
 *   - approvalHash is recomputed from them (same as packages/shared approval-hash.ts).
 * What the page shows ("You're approving …") comes from the checked plan, not the card.
 */
import { canonicalize } from '@penny/shared/canonical';
import { sha256, toBase64Url } from './chain/encoding.ts';

export type Intent = { type: string; to: string; amount: string; asset: string };

type Plan = Record<string, unknown> & { kind?: string };

export type CheckedApproval = {
  id: string;
  intent: Intent;
  approvalHash: string;
  challenge: string;
  plan: Plan;
  /** The Approval DTO the browser key signs over (actions, nonce, max block height). */
  detail: Record<string, unknown> & { id: string; kind: string; planHash: string; plan: Plan };
};

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

/** Same mapping as approvalActionOf() in packages/shared/src/approval-hash.ts. */
export function intentOf(plan: Plan): Intent | null {
  switch (plan.kind) {
    case 'send':
      return str(plan.to) && str(plan.amount) && str(plan.asset)
        ? {
            type: 'send',
            to: plan.to as string,
            amount: plan.amount as string,
            asset: plan.asset as string,
          }
        : null;
    case 'invest':
      return str(plan.portfolioId) && str(plan.amountUsd)
        ? {
            type: 'invest',
            to: plan.portfolioId as string,
            amount: plan.amountUsd as string,
            asset: 'USDC',
          }
        : null;
    case 'pay_bill':
      return str(plan.payee) && str(plan.amount) && str(plan.asset)
        ? {
            type: 'pay_bill',
            to: plan.payee as string,
            amount: plan.amount as string,
            asset: plan.asset as string,
          }
        : null;
    case 'errand':
      return str(plan.taskId) && str(plan.amount) && str(plan.asset)
        ? {
            type: 'errand',
            to: plan.taskId as string,
            amount: plan.amount as string,
            asset: plan.asset as string,
          }
        : null;
    case 'split':
      return str(plan.total)
        ? { type: 'split', to: 'group', amount: plan.total as string, asset: 'USDC' }
        : null;
    case 'create_bot': {
      const caps = plan.permissions as { dailyCap?: string } | undefined;
      return str(plan.slug)
        ? {
            type: 'create_bot',
            to: plan.slug as string,
            amount: caps?.dailyCap ?? '0',
            asset: 'USDC',
          }
        : null;
    }
    case 'write':
      return str(plan.toolkit) && str(plan.toolSlug)
        ? { type: 'write', to: `${plan.toolkit}:${plan.toolSlug}`, amount: '0', asset: 'none' }
        : null;
    default:
      return null;
  }
}

const enc = (s: string) => new TextEncoder().encode(s);
const hashOf = async (s: string) => toBase64Url(await sha256(enc(s)));

/** The approve message (same as approvalSignMessage in packages/shared). */
export const approveMessage = (hash: string, challenge: string) =>
  `penny-approval:v2:${hash}:${challenge}`;
export const unfreezeMessage = (cardId: string, challenge: string) =>
  `penny-unfreeze:v1:${cardId}:${challenge}`;

/** The passkey challenge bound to a message: base64url(sha256(UTF-8(message))). */
export const boundChallenge = (message: string) => hashOf(message);

/**
 * Check an approval from GET /v1/approvals/by-token/:token. Throws (never signs) when
 * anything doesn't add up.
 */
export async function checkApproval(a: {
  id: string;
  action: Intent;
  approvalHash: string;
  challenge?: string;
  expiresAt: string;
  status: string;
  detail: unknown;
}): Promise<CheckedApproval> {
  const d = a.detail as CheckedApproval['detail'] & {
    actions?: unknown;
    expiresAt?: string;
    status?: string;
  };
  if (!d || typeof d !== 'object' || d.id !== a.id) throw new Error('approval id mismatch');
  if (a.status !== 'pending' || d.status !== 'pending' || !a.challenge)
    throw new Error('not pending');
  if (d.expiresAt !== a.expiresAt) throw new Error('expiry mismatch');
  const planHash = await hashOf(canonicalize({ plan: d.plan, actions: d.actions }));
  if (planHash !== d.planHash) throw new Error('planHash mismatch');
  const intent = intentOf(d.plan);
  if (!intent) throw new Error('unknown plan');
  if (canonicalize(intent) !== canonicalize(a.action)) throw new Error('action mismatch');
  const hash = await hashOf(
    canonicalize({ action: intent, expiresAt: a.expiresAt, id: a.id, planHash }),
  );
  if (hash !== a.approvalHash) throw new Error('approvalHash mismatch');
  return { id: a.id, intent, approvalHash: hash, challenge: a.challenge, plan: d.plan, detail: d };
}

/** "Send 0.1 NEAR to amara.testnet": what Face ID approves, from the checked plan. */
export function describe(c: CheckedApproval): string {
  const { type, to, amount, asset } = c.intent;
  switch (type) {
    case 'send':
      return `Send ${amount} ${asset} to ${to}`;
    case 'invest':
      return `Buy $${amount} of ${to}`;
    case 'pay_bill':
      return `Pay ${amount} ${asset} to ${to}`;
    case 'errand':
      return `Pay ${amount} ${asset} for this errand`;
    case 'write':
      return `Send in ${String(c.plan.toolkit)} as you`;
    case 'create_bot':
      return `Turn on the bot ${to}`;
    default:
      return 'Approve this';
  }
}

// Control and direction characters could hide or reorder text.
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
const HIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;

/** Every argument of a write, in full (the signature seals all of them). */
export function writeFields(c: CheckedApproval): { key: string; value: string }[] {
  if (c.plan.kind !== 'write') return [];
  const args = (c.plan.arguments ?? {}) as Record<string, unknown>;
  return Object.keys(args)
    .sort()
    .map((key) => {
      const v = args[key];
      return { key, value: (typeof v === 'string' ? v : JSON.stringify(v)).replace(HIDDEN, ' ') };
    });
}
