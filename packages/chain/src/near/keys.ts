import { KeyPair, type KeyPairString, KeyType, PublicKey } from '@near-js/crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { EncodingError, fromBase58, fromBase64Url, toBase58 } from '../util/encoding.ts';

/**
 * Accepts a device public key as either NEAR string form ("ed25519:<base58>")
 * or the enrollment wire form (base64url of 32 raw bytes, ARCHITECTURE.md /v1/devices/enroll).
 * Returns the canonical NEAR string. Rejects anything that is not a valid ed25519 point.
 */
export function normalizeEd25519PublicKey(input: string): string {
  let raw: Uint8Array;
  if (input.startsWith('ed25519:')) raw = fromBase58(input.slice('ed25519:'.length));
  else if (input.includes(':')) throw new EncodingError('only ed25519 keys are accepted');
  else raw = fromBase64Url(input);
  if (raw.length !== 32) throw new EncodingError('ed25519 public key must be 32 bytes');
  try {
    ed25519.Point.fromBytes(raw);
  } catch {
    throw new EncodingError('not a valid ed25519 point');
  }
  return `ed25519:${toBase58(raw)}`;
}

export function publicKeyFromString(s: string): PublicKey {
  return PublicKey.fromString(normalizeEd25519PublicKey(s));
}

export function ed25519PublicKey(raw: Uint8Array): PublicKey {
  return new PublicKey({ keyType: KeyType.ED25519, data: raw });
}

/** Signs NEAR tx hashes. Backed by an in-memory key now; a KMS implementation can replace it later. */
export interface TxSigner {
  readonly accountId: string;
  readonly publicKey: PublicKey;
  /** Sign a 32-byte message hash; returns a 64-byte ed25519 signature. */
  sign(hash: Uint8Array): Promise<Uint8Array>;
}

export class KeyPairSigner implements TxSigner {
  readonly publicKey: PublicKey;
  private readonly kp: KeyPair;
  constructor(
    readonly accountId: string,
    secretKey: string,
  ) {
    if (!secretKey.startsWith('ed25519:'))
      throw new EncodingError('signer key must be an ed25519 secret key string');
    this.kp = KeyPair.fromString(secretKey as KeyPairString);
    this.publicKey = this.kp.getPublicKey();
  }
  async sign(hash: Uint8Array): Promise<Uint8Array> {
    return this.kp.sign(hash).signature;
  }
  /** Never expose the secret in logs/JSON. */
  toJSON(): { accountId: string; publicKey: string } {
    return { accountId: this.accountId, publicKey: this.publicKey.toString() };
  }
}
