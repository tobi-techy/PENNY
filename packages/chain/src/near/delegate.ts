import { KeyType, PublicKey } from '@near-js/crypto';
import {
  actionCreators,
  buildDelegateAction,
  encodeSignedDelegate,
  SCHEMA,
  Signature,
  SignedDelegate,
} from '@near-js/transactions';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { deserialize, serialize } from 'borsh';
import { canonicalBytes } from '../util/canonical.ts';
import { bytesEqual, fromBase58, fromBase64, toBase58 } from '../util/encoding.ts';
import type { AccessKeyInfo } from './rpc.ts';
import { type ApprovalSigningFields, MAX_TX_GAS, type NearActionSpec } from './types.ts';

export const MAX_SDA_BYTES = 16_384;
/** NEP-461 actionable-message prefix for NEP-366: 2^30 + 366. */
export const NEP366_PREFIX = 2 ** 30 + 366;

export type DecodedAction =
  | { type: 'FunctionCall'; methodName: string; args: Uint8Array; gas: bigint; deposit: bigint }
  | { type: 'Transfer'; deposit: bigint }
  /** Any other action kind (AddKey, DeleteKey, DeployContract, Stake, ...). Never accepted on money paths. */
  | { type: 'Other'; kind: string };

export interface DecodedSignedDelegate {
  senderId: string;
  receiverId: string;
  actions: DecodedAction[];
  nonce: bigint;
  maxBlockHeight: bigint;
  /** "ed25519:<base58>" or "secp256k1:<base58>" */
  publicKey: string;
  publicKeyType: 'ed25519' | 'secp256k1';
  signature: Uint8Array;
  signatureType: 'ed25519' | 'secp256k1';
  /** sha256(borsh(NEP-461 prefix u32 = 2^30 + 366) ++ borsh(DelegateAction)): what the key signed. */
  signedHash: Uint8Array;
  /** The exact input bytes. */
  bytes: Uint8Array;
}

export class DelegateDecodeError extends Error {
  override name = 'DelegateDecodeError';
}

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);
const toU8 = (v: unknown): Uint8Array => {
  if (v instanceof Uint8Array) return v;
  if (Array.isArray(v) && v.every((n) => typeof n === 'number'))
    return Uint8Array.from(v as number[]);
  throw new DelegateDecodeError('expected bytes');
};
const toBig = (v: unknown): bigint => {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isSafeInteger(v)) return BigInt(v);
  throw new DelegateDecodeError('expected integer');
};

function enumKey(v: unknown): [string, Raw] {
  if (!isObj(v)) throw new DelegateDecodeError('expected borsh enum');
  const keys = Object.keys(v);
  if (keys.length !== 1 || keys[0] === undefined)
    throw new DelegateDecodeError('ambiguous borsh enum');
  const inner = v[keys[0]];
  return [keys[0], isObj(inner) ? inner : {}];
}

function decodeKey(v: unknown): { str: string; type: 'ed25519' | 'secp256k1'; raw: Uint8Array } {
  const [k, inner] = enumKey(v);
  const raw = toU8(inner.data);
  if (k === 'ed25519Key') return { str: `ed25519:${toBase58(raw)}`, type: 'ed25519', raw };
  if (k === 'secp256k1Key') return { str: `secp256k1:${toBase58(raw)}`, type: 'secp256k1', raw };
  throw new DelegateDecodeError(`unknown key type ${k}`);
}

function decodeAction(v: unknown): DecodedAction {
  const [k, inner] = enumKey(v);
  if (k === 'functionCall') {
    if (typeof inner.methodName !== 'string') throw new DelegateDecodeError('bad methodName');
    return {
      type: 'FunctionCall',
      methodName: inner.methodName,
      args: toU8(inner.args),
      gas: toBig(inner.gas),
      deposit: toBig(inner.deposit),
    };
  }
  if (k === 'transfer') return { type: 'Transfer', deposit: toBig(inner.deposit) };
  return { type: 'Other', kind: k };
}

/**
 * Build + sign a NEP-366 SignedDelegateAction with a raw ed25519 secret key.
 * Mirrors what the iPhone does (Borsh in PennyCore/delegate-vectors.json).
 * Returns standard base64 (padded), ready for ApprovalService.submit.
 */
export function buildSignedDelegateAction(p: {
  secretKey: Uint8Array;
  senderId: string;
  receiverId: string;
  actions: NearActionSpec[];
  nonce: bigint;
  maxBlockHeight: bigint;
}): string {
  const raw = ed25519.getPublicKey(p.secretKey);
  const actions = p.actions.map((a) =>
    a.type === 'Transfer'
      ? actionCreators.transfer(BigInt(a.deposit))
      : actionCreators.functionCall(a.methodName, canonicalBytes(a.args), BigInt(a.gas), BigInt(a.deposit)),
  );
  const da = buildDelegateAction({
    senderId: p.senderId,
    receiverId: p.receiverId,
    actions,
    nonce: p.nonce,
    maxBlockHeight: p.maxBlockHeight,
    publicKey: new PublicKey({ keyType: KeyType.ED25519, data: raw }),
  });
  const message = new Uint8Array([
    ...serialize(SCHEMA.DelegateActionPrefix, { prefix: NEP366_PREFIX }),
    ...serialize(SCHEMA.DelegateAction, da),
  ]);
  const sig = ed25519.sign(sha256(message), p.secretKey);
  const sd = new SignedDelegate({
    delegateAction: da,
    signature: new Signature({ keyType: KeyType.ED25519, data: sig }),
  });
  return Buffer.from(encodeSignedDelegate(sd)).toString('base64');
}

/** Decode a base64 (standard, padded) borsh NEP-366 SignedDelegateAction. Rejects non-canonical encodings. */
export function decodeSignedDelegateAction(b64: string): DecodedSignedDelegate {
  if (b64.length > Math.ceil(MAX_SDA_BYTES / 3) * 4)
    throw new DelegateDecodeError('payload too large');
  const bytes = fromBase64(b64);
  let raw: unknown;
  try {
    raw = deserialize(SCHEMA.SignedDelegate, bytes);
  } catch (e) {
    throw new DelegateDecodeError(`borsh decode failed: ${(e as Error).message}`);
  }
  if (!isObj(raw) || !isObj(raw.delegateAction))
    throw new DelegateDecodeError('missing delegateAction');
  // Canonical round-trip: rejects trailing bytes and any alternative encodings.
  let reencoded: Uint8Array;
  try {
    reencoded = serialize(SCHEMA.SignedDelegate, raw);
  } catch (e) {
    throw new DelegateDecodeError(`borsh re-encode failed: ${(e as Error).message}`);
  }
  if (!bytesEqual(reencoded, bytes))
    throw new DelegateDecodeError('non-canonical encoding or trailing bytes');

  const da = raw.delegateAction;
  if (typeof da.senderId !== 'string' || typeof da.receiverId !== 'string')
    throw new DelegateDecodeError('bad account ids');
  if (!Array.isArray(da.actions)) throw new DelegateDecodeError('bad actions');
  const key = decodeKey(da.publicKey);
  const [sigKind, sigInner] = enumKey(raw.signature);
  const signature = toU8(sigInner.data);
  const signatureType =
    sigKind === 'ed25519Signature'
      ? 'ed25519'
      : sigKind === 'secp256k1Signature'
        ? 'secp256k1'
        : null;
  if (!signatureType) throw new DelegateDecodeError(`unknown signature type ${sigKind}`);

  const message = new Uint8Array([
    ...serialize(SCHEMA.DelegateActionPrefix, { prefix: NEP366_PREFIX }),
    ...serialize(SCHEMA.DelegateAction, da),
  ]);

  return {
    senderId: da.senderId,
    receiverId: da.receiverId,
    actions: da.actions.map(decodeAction),
    nonce: toBig(da.nonce),
    maxBlockHeight: toBig(da.maxBlockHeight),
    publicKey: key.str,
    publicKeyType: key.type,
    signature,
    signatureType,
    signedHash: sha256(message),
    bytes,
  };
}

// ---------------------------------------------------------------------------

export type VerifyFailure =
  | 'DECODE'
  | 'SENDER_MISMATCH'
  | 'RECEIVER_MISMATCH'
  | 'KEY_TYPE'
  | 'KEY_NOT_EXPECTED'
  | 'KEY_NOT_ON_CHAIN'
  | 'KEY_NOT_FULL_ACCESS'
  | 'BAD_SIGNATURE'
  | 'ACTION_COUNT'
  | 'ACTION_MISMATCH'
  | 'FORBIDDEN_ACTION'
  | 'GAS_CAP'
  | 'DEPOSIT_CAP'
  | 'NONCE_MISMATCH'
  | 'NONCE_STALE'
  | 'NONCE_TOO_LARGE'
  | 'MAX_BLOCK_HEIGHT_MISMATCH'
  | 'EXPIRED'
  | 'MAX_BLOCK_HEIGHT_TOO_FAR';

export type VerifyResult =
  | { ok: true; sda: DecodedSignedDelegate; onChainNonce: bigint; blockHeight: bigint }
  | { ok: false; reason: VerifyFailure; detail: string };

export interface ChainView {
  /** All access keys of `accountId` plus the block height they were read at. */
  viewAccessKeyList(accountId: string): Promise<{ keys: AccessKeyInfo[]; blockHeight: bigint }>;
}

export interface VerifyPolicy {
  /** Per-action gas ceiling. Default 100 Tgas. */
  maxGasPerAction?: bigint;
  /** Sum of gas ceiling. Default 300 Tgas. */
  maxTotalGas?: bigint;
  /**
   * Total attached deposit ceiling (yoctoNEAR). The RELAYER pays inner deposits
   * (docs.near.org meta-tx), so this is a relayer-drain guard. Default 0.01 NEAR.
   * Callers relaying Guard-approved amounts must raise it deliberately.
   */
  maxTotalDeposit?: bigint;
  /** Reject a maxBlockHeight more than this many blocks ahead of the chain. Default 1500 (~15 min at 0.6 s blocks; 10-min sends need ~1260). */
  maxBlocksAhead?: bigint;
  /** If set, the delegate must be signed by exactly this key (the enrolled device key). */
  expectedPublicKey?: string;
}

export const DEFAULT_POLICY = {
  maxGasPerAction: 100n * 10n ** 12n,
  maxTotalGas: MAX_TX_GAS,
  maxTotalDeposit: 10n ** 22n,
  maxBlocksAhead: 1500n,
} as const;

const fail = (reason: VerifyFailure, detail: string): VerifyResult => ({
  ok: false,
  reason,
  detail,
});

function matchAction(i: number, got: DecodedAction, want: NearActionSpec): VerifyResult | null {
  if (got.type === 'Other') return fail('FORBIDDEN_ACTION', `action ${i} is ${got.kind}`);
  if (got.type !== want.type)
    return fail('ACTION_MISMATCH', `action ${i} type ${got.type} != ${want.type}`);
  if (got.type === 'Transfer' && want.type === 'Transfer') {
    if (got.deposit !== BigInt(want.deposit)) return fail('ACTION_MISMATCH', `action ${i} deposit`);
    return null;
  }
  if (got.type === 'FunctionCall' && want.type === 'FunctionCall') {
    if (got.methodName !== want.methodName)
      return fail('ACTION_MISMATCH', `action ${i} methodName`);
    // Byte-for-byte: the device must sign RFC 8785 canonical JSON of the approved args.
    if (!bytesEqual(got.args, canonicalBytes(want.args)))
      return fail('ACTION_MISMATCH', `action ${i} args bytes`);
    if (got.gas !== BigInt(want.gas)) return fail('ACTION_MISMATCH', `action ${i} gas`);
    if (got.deposit !== BigInt(want.deposit)) return fail('ACTION_MISMATCH', `action ${i} deposit`);
    return null;
  }
  return fail('ACTION_MISMATCH', `action ${i}`);
}

/**
 * Verify a device-signed delegate action against the approved plan, byte-for-byte,
 * and against chain state. Pure apart from one RPC read (view_access_key_list).
 * Order: cheap structural checks first, then signature, then chain state.
 */
export async function verifySignedDelegateAction(
  sdaB64: string,
  expected: ApprovalSigningFields,
  chain: ChainView,
  policy: VerifyPolicy = {},
): Promise<VerifyResult> {
  const p = { ...DEFAULT_POLICY, ...policy };
  let sda: DecodedSignedDelegate;
  try {
    sda = decodeSignedDelegateAction(sdaB64);
  } catch (e) {
    return fail('DECODE', (e as Error).message);
  }

  if (sda.senderId !== expected.signerId) return fail('SENDER_MISMATCH', sda.senderId);
  if (sda.receiverId !== expected.receiverId) return fail('RECEIVER_MISMATCH', sda.receiverId);
  if (sda.publicKeyType !== 'ed25519' || sda.signatureType !== 'ed25519')
    return fail('KEY_TYPE', 'device keys are ed25519 only');
  if (p.expectedPublicKey !== undefined && sda.publicKey !== p.expectedPublicKey)
    return fail('KEY_NOT_EXPECTED', sda.publicKey);

  if (sda.actions.length !== expected.actions.length) {
    return fail('ACTION_COUNT', `${sda.actions.length} != ${expected.actions.length}`);
  }
  let totalGas = 0n;
  let totalDeposit = 0n;
  for (let i = 0; i < sda.actions.length; i++) {
    const got = sda.actions[i];
    const want = expected.actions[i];
    if (!got || !want) return fail('ACTION_COUNT', `missing action ${i}`);
    const r = matchAction(i, got, want);
    if (r) return r;
    if (got.type === 'FunctionCall') {
      if (got.gas > p.maxGasPerAction) return fail('GAS_CAP', `action ${i} gas ${got.gas}`);
      totalGas += got.gas;
      totalDeposit += got.deposit;
    } else if (got.type === 'Transfer') {
      totalDeposit += got.deposit;
    }
  }
  if (totalGas > p.maxTotalGas) return fail('GAS_CAP', `total gas ${totalGas}`);
  if (totalDeposit > p.maxTotalDeposit) return fail('DEPOSIT_CAP', `total deposit ${totalDeposit}`);

  if (sda.nonce !== BigInt(expected.nonce)) return fail('NONCE_MISMATCH', `${sda.nonce}`);
  if (sda.maxBlockHeight !== BigInt(expected.maxBlockHeight))
    return fail('MAX_BLOCK_HEIGHT_MISMATCH', `${sda.maxBlockHeight}`);

  const pub = sda.publicKey.slice('ed25519:'.length);
  let sigOk = false;
  try {
    sigOk = ed25519.verify(sda.signature, sda.signedHash, fromBase58(pub));
  } catch {
    sigOk = false;
  }
  if (!sigOk) return fail('BAD_SIGNATURE', 'ed25519 verify failed');

  const { keys, blockHeight } = await chain.viewAccessKeyList(sda.senderId);
  const key = keys.find((k) => k.publicKey === sda.publicKey);
  if (!key) return fail('KEY_NOT_ON_CHAIN', sda.publicKey);
  if (key.permission !== 'FullAccess') return fail('KEY_NOT_FULL_ACCESS', sda.publicKey);
  if (sda.nonce <= key.nonce)
    return fail('NONCE_STALE', `signed ${sda.nonce} <= on-chain ${key.nonce}`);
  // nearcore: DelegateActionNonceTooLarge when nonce > block_height * 1e6 (NEP-366).
  if (sda.nonce > blockHeight * 1_000_000n) return fail('NONCE_TOO_LARGE', `${sda.nonce}`);
  if (sda.maxBlockHeight <= blockHeight)
    return fail('EXPIRED', `maxBlockHeight ${sda.maxBlockHeight} <= ${blockHeight}`);
  if (sda.maxBlockHeight - blockHeight > p.maxBlocksAhead)
    return fail('MAX_BLOCK_HEIGHT_TOO_FAR', `${sda.maxBlockHeight}`);

  return { ok: true, sda, onChainNonce: key.nonce, blockHeight };
}
