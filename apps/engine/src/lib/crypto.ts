import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify } from 'node:crypto';

/** 32 random bytes, base64url (43 chars). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256Hex(s: string | Uint8Array): string {
  return createHash('sha256').update(s).digest('hex');
}

/** Constant-time string compare. Different lengths -> false without throwing. */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    // still burn comparable time
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/** Random code from an alphabet using rejection sampling (no modulo bias). */
export function randomCode(length: number, alphabet: string): string {
  const max = Math.floor(256 / alphabet.length) * alphabet.length;
  let out = '';
  while (out.length < length) {
    for (const b of randomBytes(length * 2)) {
      if (b < max && out.length < length) out += alphabet[b % alphabet.length];
    }
  }
  return out;
}

/** Verify an ed25519 signature given a raw 32-byte public key (base64url). */
export function verifyEd25519(
  publicKeyB64Url: string,
  message: Uint8Array,
  signature: Uint8Array,
): boolean {
  try {
    const raw = Buffer.from(publicKeyB64Url, 'base64url');
    if (raw.length !== 32 || signature.length !== 64) return false;
    const key = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: publicKeyB64Url },
      format: 'jwk',
    });
    return verify(null, message, key, signature);
  } catch {
    return false;
  }
}
