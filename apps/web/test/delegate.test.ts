import { describe, expect, test } from 'bun:test';
import { KeyType, PublicKey } from '@near-js/crypto';
import {
  actionCreators,
  buildDelegateAction,
  encodeSignedDelegate as nearEncodeSigned,
  Signature,
  SignedDelegate,
} from '@near-js/transactions';
import { ed25519 } from '@noble/curves/ed25519.js';
import { type ChainView, canonicalBytes, verifySignedDelegateAction } from '@penny/chain';
import { planApprovalMessage as sharedPlanMessage } from '../../../packages/shared/src/schemas.ts';
import {
  delegateSigningHash,
  encodeDelegateAction,
  encodeSignedDelegate,
  nearPublicKey,
  planApprovalMessage,
} from '../src/chain/delegate.ts';
import { fromBase64, toBase64 } from '../src/chain/encoding.ts';
import { type ApprovalForSigning, signApproval } from '../src/chain/sign.ts';

const seed = new Uint8Array(32).fill(7);
const pub = ed25519.getPublicKey(seed);
const signer = { publicKey: pub, sign: async (m: Uint8Array) => ed25519.sign(m, seed) };

const approval: ApprovalForSigning = {
  id: 'apr_01JBX5T7K9M2Q4R6S8V0W2Y4Z6',
  kind: 'send',
  planHash: 'x'.repeat(43),
  signerId: 'tobi.penny.near',
  receiverId: 'usdc.near',
  actions: [
    {
      type: 'FunctionCall',
      methodName: 'ft_transfer',
      args: { receiver_id: 'ada.near', amount: '5000000', memo: 'suya 🍢' },
      gas: '30000000000000',
      deposit: '1',
    },
    { type: 'Transfer', deposit: '0' },
  ],
  nonce: '123456789012',
  maxBlockHeight: '150000600',
};

function chainView(nonce = 1n, height = 150_000_000n): ChainView {
  return {
    async viewAccessKeyList() {
      return {
        keys: [{ publicKey: nearPublicKey(pub), nonce, permission: 'FullAccess' as const }],
        blockHeight: height,
      };
    },
  };
}

describe('web NEP-366 encoder', () => {
  test('matches @near-js/transactions byte for byte', async () => {
    const da = encodeDelegateAction(approval, pub);
    const sig = ed25519.sign(await delegateSigningHash(da), seed);
    const ours = encodeSignedDelegate(da, sig);

    const nearDa = buildDelegateAction({
      senderId: approval.signerId,
      receiverId: approval.receiverId,
      actions: [
        actionCreators.functionCall(
          'ft_transfer',
          canonicalBytes({ receiver_id: 'ada.near', amount: '5000000', memo: 'suya 🍢' }),
          30_000_000_000_000n,
          1n,
        ),
        actionCreators.transfer(0n),
      ],
      nonce: 123456789012n,
      maxBlockHeight: 150000600n,
      publicKey: new PublicKey({ keyType: KeyType.ED25519, data: pub }),
    });
    const theirs = nearEncodeSigned(
      new SignedDelegate({
        delegateAction: nearDa,
        signature: new Signature({ keyType: KeyType.ED25519, data: sig }),
      }),
    );
    expect(toBase64(ours)).toBe(toBase64(theirs));
  });

  test('passes @penny/chain verifySignedDelegateAction', async () => {
    const body = await signApproval(approval, signer);
    if (!('signedDelegateAction' in body)) throw new Error('expected SDA');
    const r = await verifySignedDelegateAction(body.signedDelegateAction, approval, chainView(), {
      expectedPublicKey: nearPublicKey(pub),
    });
    expect(r.ok).toBe(true);
  });

  test('a tampered amount fails verification', async () => {
    const body = await signApproval(approval, signer);
    if (!('signedDelegateAction' in body)) throw new Error('expected SDA');
    const changed = structuredClone(approval);
    const first = changed.actions[0];
    if (first?.type === 'FunctionCall') first.args.amount = '5000001';
    const r = await verifySignedDelegateAction(body.signedDelegateAction, changed, chainView());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('ACTION_MISMATCH');
  });

  test('a different key fails verification', async () => {
    const other = new Uint8Array(32).fill(9);
    const body = await signApproval(approval, {
      publicKey: pub,
      sign: async (m) => ed25519.sign(m, other),
    });
    if (!('signedDelegateAction' in body)) throw new Error('expected SDA');
    const r = await verifySignedDelegateAction(body.signedDelegateAction, approval, chainView());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('BAD_SIGNATURE');
  });

  test('rejects out-of-range numbers and bad keys', () => {
    expect(() => encodeDelegateAction({ ...approval, nonce: '-1' }, pub)).toThrow();
    expect(() =>
      encodeDelegateAction({ ...approval, nonce: '18446744073709551616' }, pub),
    ).toThrow();
    expect(() => encodeDelegateAction(approval, pub.slice(1))).toThrow();
    expect(() => encodeDelegateAction({ ...approval, actions: [] }, pub)).toThrow();
  });

  test('create_bot signs the plan message, matching packages/shared', async () => {
    const bot = { ...approval, kind: 'create_bot', actions: [] };
    expect(planApprovalMessage(bot.id, bot.planHash)).toBe(sharedPlanMessage(bot.id, bot.planHash));
    const body = await signApproval(bot, signer);
    if (!('planSignature' in body)) throw new Error('expected planSignature');
    expect(body.planSignature).toHaveLength(86);
    const msg = new TextEncoder().encode(planApprovalMessage(bot.id, bot.planHash));
    expect(ed25519.verify(fromBase64(body.planSignature), msg, pub)).toBe(true);
  });
});
