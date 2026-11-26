/**
 * Minimal NEP-366 encoder for the browser. Mirrors ios/PennyKit DelegateAction.swift and
 * produces bytes identical to @near-js/transactions encodeSignedDelegate (see test/delegate.test.ts,
 * which also runs @penny/chain's verifySignedDelegateAction over the output).
 *
 * packages/chain only ships a decoder and pulls Node-only deps, so the browser carries this
 * ~80-line writer instead of the full near-js stack.
 */
import { canonicalize } from '@penny/shared/canonical';
import { concat, sha256, toBase58 } from './encoding.ts';

/** NEP-461 actionable-message prefix for NEP-366: 2^30 + 366. */
export const NEP366_PREFIX = 2 ** 30 + 366;

export type NearActionSpec =
  | {
      type: 'FunctionCall';
      methodName: string;
      args: Record<string, unknown>;
      gas: string;
      deposit: string;
    }
  | { type: 'Transfer'; deposit: string };

export interface DelegateFields {
  signerId: string;
  receiverId: string;
  actions: NearActionSpec[];
  nonce: string;
  maxBlockHeight: string;
}

const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;

class Writer {
  private chunks: number[] = [];
  u8(n: number) {
    this.chunks.push(n & 0xff);
  }
  u32(n: number) {
    if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new RangeError('u32');
    for (let i = 0; i < 4; i++) this.u8(n >>> (8 * i));
  }
  uint(v: bigint, bytes: number, max: bigint) {
    if (v < 0n || v > max) throw new RangeError(`u${bytes * 8} out of range`);
    for (let i = 0; i < bytes; i++) this.u8(Number((v >> BigInt(8 * i)) & 0xffn));
  }
  fixed(b: Uint8Array) {
    for (const x of b) this.u8(x);
  }
  bytes(b: Uint8Array) {
    this.u32(b.length);
    this.fixed(b);
  }
  string(s: string) {
    this.bytes(new TextEncoder().encode(s));
  }
  out(): Uint8Array {
    return Uint8Array.from(this.chunks);
  }
}

const parseUint = (s: string, max: bigint, what: string): bigint => {
  if (!/^(0|[1-9]\d*)$/.test(s)) throw new RangeError(`${what} must be a decimal string`);
  const v = BigInt(s);
  if (v > max) throw new RangeError(`${what} out of range`);
  return v;
};

/** borsh(DelegateAction). Action tags from nearcore: FunctionCall=2, Transfer=3. */
export function encodeDelegateAction(f: DelegateFields, publicKey: Uint8Array): Uint8Array {
  if (publicKey.length !== 32) throw new RangeError('ed25519 public key must be 32 bytes');
  if (f.actions.length < 1 || f.actions.length > 8) throw new RangeError('1 to 8 actions');
  const w = new Writer();
  w.string(f.signerId);
  w.string(f.receiverId);
  w.u32(f.actions.length);
  for (const a of f.actions) {
    if (a.type === 'FunctionCall') {
      w.u8(2);
      w.string(a.methodName);
      // Byte for byte what the engine verifies: RFC 8785 canonical JSON of the approved args.
      w.bytes(new TextEncoder().encode(canonicalize(a.args)));
      w.uint(parseUint(a.gas, U64_MAX, 'gas'), 8, U64_MAX);
      w.uint(parseUint(a.deposit, U128_MAX, 'deposit'), 16, U128_MAX);
    } else if (a.type === 'Transfer') {
      w.u8(3);
      w.uint(parseUint(a.deposit, U128_MAX, 'deposit'), 16, U128_MAX);
    } else {
      throw new TypeError('only FunctionCall and Transfer can be signed');
    }
  }
  w.uint(parseUint(f.nonce, U64_MAX, 'nonce'), 8, U64_MAX);
  w.uint(parseUint(f.maxBlockHeight, U64_MAX, 'maxBlockHeight'), 8, U64_MAX);
  w.u8(0); // KeyType::ED25519
  w.fixed(publicKey);
  return w.out();
}

/** The bytes the device key signs: sha256(borsh(u32 prefix) ++ borsh(DelegateAction)). */
export async function delegateSigningHash(daBytes: Uint8Array): Promise<Uint8Array> {
  const w = new Writer();
  w.u32(NEP366_PREFIX);
  return sha256(concat(w.out(), daBytes));
}

/** borsh(SignedDelegate) = borsh(DelegateAction) ++ Signature::ED25519(64 bytes). */
export function encodeSignedDelegate(daBytes: Uint8Array, signature: Uint8Array): Uint8Array {
  if (signature.length !== 64) throw new RangeError('ed25519 signature must be 64 bytes');
  return concat(daBytes, Uint8Array.of(0), signature);
}

export const nearPublicKey = (raw: Uint8Array) => `ed25519:${toBase58(raw)}`;

/** Message signed for approvals with no NEAR actions (create_bot). Mirrors packages/shared. */
export function planApprovalMessage(approvalId: string, planHashValue: string): string {
  return `penny-approval:v1:${approvalId}:${planHashValue}`;
}

/**
 * The message the device key signs to approve a money action. Mirrors
 * approvalSignMessage() in packages/shared, which pulls node:crypto and cannot be
 * bundled for the browser; the domain prefix keeps it from being read as a NEAR payload.
 */
export function approvalSignMessage(approvalHashValue: string, challenge: string): string {
  return `penny-approval:v2:${approvalHashValue}:${challenge}`;
}
