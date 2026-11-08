import { describe, expect, test } from 'bun:test';
import {
  approvalActionOf,
  approvalHash,
  approvalSignMessage,
  type IntentPlan,
  passkeyChallengeFor,
  planHash,
  unfreezeMessage as sharedUnfreeze,
} from '../../../packages/shared/src/index.ts';
import {
  approveMessage,
  boundChallenge,
  checkApproval,
  describe as describeApproval,
  unfreezeMessage,
  writeFields,
} from '../src/ticket.ts';

const id = 'apr_01JC0000000000000000000000';
const expiresAt = '2026-11-05T19:10:00.000Z';
const challenge = `${'A'.repeat(42)}Q`;

function ticket(plan: IntentPlan, actions: unknown[], over: Record<string, unknown> = {}) {
  const ph = planHash(plan, actions as never);
  const action = approvalActionOf(plan);
  return {
    id,
    action,
    approvalHash: approvalHash({ id, action, expiresAt, planHash: ph }),
    challenge,
    expiresAt,
    status: 'pending',
    detail: { id, kind: plan.kind, plan, actions, planHash: ph, expiresAt, status: 'pending' },
    ...over,
  };
}

const sendPlan: IntentPlan = { kind: 'send', asset: 'NEAR', amount: '0.1', to: 'amara.testnet' };
const sendActions = [{ type: 'Transfer', deposit: '100000000000000000000000' }];

describe('the page checks an approval before it signs', () => {
  test('a genuine approval passes and reads in plain words', async () => {
    const c = await checkApproval(ticket(sendPlan, sendActions));
    expect(describeApproval(c)).toBe('Send 0.1 NEAR to amara.testnet');
  });

  test('a different amount in the NEAR actions than in the plan is refused', async () => {
    const t = ticket(sendPlan, sendActions);
    (t.detail as { actions: unknown[] }).actions = [
      { type: 'Transfer', deposit: '9000000000000000000000000' },
    ];
    await expect(checkApproval(t)).rejects.toThrow('planHash mismatch');
  });

  test('a card that says one thing while the plan says another is refused', async () => {
    const t = ticket(sendPlan, sendActions, {
      action: { ...approvalActionOf(sendPlan), to: 'evil.testnet' },
    });
    await expect(checkApproval(t)).rejects.toThrow('action mismatch');
  });

  test('a hash the server made up is refused', async () => {
    const t = ticket(sendPlan, sendActions, { approvalHash: 'x'.repeat(43) });
    await expect(checkApproval(t)).rejects.toThrow('approvalHash mismatch');
  });

  test('a used challenge is never signed', async () => {
    await expect(
      checkApproval(ticket(sendPlan, sendActions, { challenge: undefined })),
    ).rejects.toThrow();
  });

  test('a write shows every argument in full, not the first 120 characters', async () => {
    const body = `Hi Amara,\n${'x'.repeat(400)}\nP.S. also wire money`;
    const plan: IntentPlan = {
      kind: 'write',
      toolkit: 'gmail',
      toolSlug: 'GMAIL_SEND_EMAIL',
      title: 'Email to Amara',
      summary: 'Invoice',
      arguments: { recipient_email: 'amara@example.com', body },
    };
    const c = await checkApproval(ticket(plan, []));
    expect(writeFields(c).find((f) => f.key === 'body')?.value).toBe(body);
  });
});

describe('the passkey challenge is bound to the action', () => {
  test('same as the engine computes', async () => {
    const hash = approvalHash({ id, action: approvalActionOf(sendPlan), expiresAt, planHash: 'p' });
    expect(await boundChallenge(approveMessage(hash, challenge))).toBe(
      passkeyChallengeFor(approvalSignMessage(hash, challenge)),
    );
    expect(unfreezeMessage('crd_1', challenge)).toBe(sharedUnfreeze('crd_1', challenge));
  });
});
