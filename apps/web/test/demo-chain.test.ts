import { describe, expect, test } from 'bun:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import type { Approval } from '@penny/shared';
import { FakeChain } from '../../engine/src/ports/chain.ts';
import { DemoChain } from '../../engine/src/ports/demo-chain.ts';
import { type ApprovalForSigning, signApproval } from '../src/chain/sign.ts';

/**
 * The demo's one shortcut is that its account is never created on chain. Everything
 * else must still run, so this signs with the real browser encoder and the real
 * device key and asks the engine's DemoChain to verify it. It lives next to the
 * encoder on purpose: if the browser ever encodes something differently, the demo
 * stops accepting it exactly like the live path would.
 */
const ACCOUNT = 'demo-abcdefghijklmnopqrst.testnet';
const seed = new Uint8Array(32).fill(7);
const publicKey = ed25519.getPublicKey(seed);
const publicKeyB64Url = Buffer.from(publicKey).toString('base64url');
const signer = {
  publicKey,
  sign: async (m: Uint8Array) => ed25519.sign(m, seed),
};

const approval = (over: Partial<Approval> = {}): ApprovalForSigning =>
  ({
    id: 'apr_demo01JBX5T7K9M2Q4R6S8V0W2Y4Z6',
    kind: 'send',
    planHash: 'p'.repeat(43),
    signerId: ACCOUNT,
    receiverId: 'amara.testnet',
    actions: [{ type: 'Transfer', deposit: '5000000000000000000000000' }],
    nonce: '1',
    maxBlockHeight: '1001',
    ...over,
  }) as ApprovalForSigning;

const chain = () =>
  new DemoChain({
    inner: new FakeChain(),
    isDemoAccount: async (id) => id === ACCOUNT,
    resolveDeviceKey: async (id) => (id === ACCOUNT ? publicKeyB64Url : null),
  });

/** The engine's Approval is the signing fields plus bookkeeping the verifier ignores. */
const asApproval = (a: ApprovalForSigning): Approval =>
  ({
    ...a,
    userId: 'usr_demo',
    plan: { kind: 'send', asset: 'NEAR', amount: '5', to: 'amara.testnet' },
    title: 'Send 5 NEAR',
    amountDisplay: '5 NEAR',
    facts: [],
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    status: 'pending',
  }) as Approval;

describe('demo chain accepts a real browser signature', () => {
  test('the exact bytes the browser signed verify against the demo view', async () => {
    const a = approval();
    const signed = await signApproval(a, signer);
    if (!('signedDelegateAction' in signed)) throw new Error('expected a delegate action');
    expect(await chain().verifyDelegateAction(asApproval(a), signed.signedDelegateAction)).toEqual({
      ok: true,
    });
  });

  test('the same signature is refused when the approved amount changed', async () => {
    const a = approval();
    const signed = await signApproval(a, signer);
    if (!('signedDelegateAction' in signed)) throw new Error('expected a delegate action');
    const tampered = asApproval(
      approval({ actions: [{ type: 'Transfer', deposit: '9000000000000000000000000' }] }),
    );
    const r = await chain().verifyDelegateAction(tampered, signed.signedDelegateAction);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain('ACTION_MISMATCH');
  });

  test('a signature from a different key is refused', async () => {
    const otherSeed = new Uint8Array(32).fill(9);
    const a = approval();
    const signed = await signApproval(a, {
      publicKey: ed25519.getPublicKey(otherSeed),
      sign: async (m: Uint8Array) => ed25519.sign(m, otherSeed),
    });
    if (!('signedDelegateAction' in signed)) throw new Error('expected a delegate action');
    const r = await chain().verifyDelegateAction(asApproval(a), signed.signedDelegateAction);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain('KEY_NOT_EXPECTED');
  });

  test('a signature for another recipient is refused', async () => {
    const a = approval();
    const signed = await signApproval(a, signer);
    if (!('signedDelegateAction' in signed)) throw new Error('expected a delegate action');
    const elsewhere = asApproval(approval({ receiverId: 'someone-else.testnet' }));
    const r = await chain().verifyDelegateAction(elsewhere, signed.signedDelegateAction);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toContain('RECEIVER_MISMATCH');
  });
});
