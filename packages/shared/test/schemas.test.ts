import { describe, expect, test } from 'bun:test';
import { Approval, EnrollBody, IntentPlan, NearAccountId, SubmitBody } from '../src/index.ts';

describe('IntentPlan', () => {
  test('accepts each kind', () => {
    const plans = [
      { kind: 'invest', fromAsset: 'USDC', amountUsd: '50', portfolioId: 'p', quoteId: 'q' },
      { kind: 'send', asset: 'NEAR', amount: '1.5', to: 'ada.penny.near' },
      { kind: 'pay_bill', billId: 'b1', payee: 'IKEDC', amount: '20', asset: 'USDC' },
      { kind: 'errand', taskId: 't', bidId: 'b', amount: '5', asset: 'USDC' },
      {
        kind: 'split',
        total: '30',
        participants: [
          { handle: '+1555', share: '15' },
          { handle: '+1556', share: '15' },
        ],
      },
    ];
    for (const p of plans) expect(IntentPlan.safeParse(p).success).toBe(true);
  });
  test('rejects unknown keys on money paths (prompt-injected extras)', () => {
    const r = IntentPlan.safeParse({
      kind: 'send',
      asset: 'USDC',
      amount: '1',
      to: 'ada.near',
      receiverOverride: 'evil.near',
    });
    expect(r.success).toBe(false);
  });
  test('rejects float amounts, negative, too many dp, unknown asset', () => {
    const base = { kind: 'send', asset: 'USDC', to: 'ada.near' };
    for (const amount of [1, '-1', '1.1234567', '1e2']) {
      expect(IntentPlan.safeParse({ ...base, amount }).success).toBe(false);
    }
    expect(IntentPlan.safeParse({ ...base, amount: '1', asset: 'DOGE' }).success).toBe(false);
  });
});

describe('NearAccountId', () => {
  test('valid and invalid', () => {
    for (const ok of ['ada.penny.near', 'a1', 'my_acct-1.near', 'a'.repeat(64)]) {
      expect(NearAccountId.safeParse(ok).success).toBe(true);
    }
    for (const bad of [
      'A.near',
      'a',
      '.near',
      'ada..near',
      'ada.near.',
      'a'.repeat(65),
      'ad@.near',
    ]) {
      expect(NearAccountId.safeParse(bad).success).toBe(false);
    }
  });
});

describe('API bodies', () => {
  test('EnrollBody', () => {
    const pk = Buffer.alloc(32, 7).toString('base64url');
    expect(EnrollBody.safeParse({ enrollCode: 'ABCD2345', publicKeyEd25519: pk }).success).toBe(
      true,
    );
    expect(EnrollBody.safeParse({ enrollCode: 'abcd2345', publicKeyEd25519: pk }).success).toBe(
      false,
    );
    expect(EnrollBody.safeParse({ enrollCode: 'ABCD0345', publicKeyEd25519: pk }).success).toBe(
      false,
    );
    expect(
      EnrollBody.safeParse({ enrollCode: 'ABCD2345', publicKeyEd25519: 'short' }).success,
    ).toBe(false);
  });
  test('SubmitBody requires padded base64', () => {
    expect(SubmitBody.safeParse({ signedDelegateAction: 'AAAA' }).success).toBe(true);
    expect(SubmitBody.safeParse({ signedDelegateAction: 'AAA' }).success).toBe(false);
    expect(SubmitBody.safeParse({ signedDelegateAction: 'AAAA', extra: 1 }).success).toBe(false);
  });
});

describe('Approval', () => {
  test('parses the contract example shape', () => {
    const a = {
      id: 'apr_01JC0000000000000000000000',
      userId: 'usr_01JC0000000000000000000000',
      kind: 'invest',
      title: 'Swap · USDC → ETH Momentum',
      amountDisplay: '$50.00',
      facts: [{ label: 'Fee', value: '$0.12' }],
      signerId: 'tobi.penny.near',
      receiverId: 'usdc-contract.near',
      actions: [
        {
          type: 'FunctionCall',
          methodName: 'ft_transfer_call',
          args: { amount: '50000000' },
          gas: '30000000000000',
          deposit: '1',
        },
      ],
      nonce: '1234',
      maxBlockHeight: '123456789',
      expiresAt: '2026-11-05T19:00:00Z',
      status: 'pending',
      planHash: 'A'.repeat(43),
    };
    expect(Approval.safeParse(a).success).toBe(true);
    expect(Approval.safeParse({ ...a, nonce: '-1' }).success).toBe(false);
    expect(Approval.safeParse({ ...a, status: 'done' }).success).toBe(false);
  });
});
