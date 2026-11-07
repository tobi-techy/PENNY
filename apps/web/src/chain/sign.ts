/** Turn an engine Approval into the submit body, signed by the device key. Same as iOS. */
import {
  type DelegateFields,
  delegateSigningHash,
  encodeDelegateAction,
  encodeSignedDelegate,
  planApprovalMessage,
} from './delegate.ts';
import { sha256, toBase64, toBase64Url } from './encoding.ts';

export interface ApprovalForSigning extends DelegateFields {
  id: string;
  kind: string;
  planHash: string;
}

export interface Signer {
  publicKey: Uint8Array;
  sign(message: Uint8Array): Promise<Uint8Array>;
}

export type SubmitBody = { signedDelegateAction: string } | { planSignature: string };

/** Kinds the engine settles from a plain device signature over the plan message. */
const PLAN_SIGNED = new Set(['create_bot', 'write']);

/** What the passkey challenge binds to, computed before the prompt. */
export async function approvalDigest(a: ApprovalForSigning, pub: Uint8Array): Promise<Uint8Array> {
  if (PLAN_SIGNED.has(a.kind))
    return sha256(new TextEncoder().encode(planApprovalMessage(a.id, a.planHash)));
  return delegateSigningHash(encodeDelegateAction(a, pub));
}

export async function signApproval(a: ApprovalForSigning, signer: Signer): Promise<SubmitBody> {
  if (PLAN_SIGNED.has(a.kind)) {
    const msg = new TextEncoder().encode(planApprovalMessage(a.id, a.planHash));
    return { planSignature: toBase64Url(await signer.sign(msg)) };
  }
  const da = encodeDelegateAction(a, signer.publicKey);
  const hash = await delegateSigningHash(da);
  const sig = await signer.sign(hash);
  return { signedDelegateAction: toBase64(encodeSignedDelegate(da, sig)) };
}
