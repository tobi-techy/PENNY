import { createHash } from 'node:crypto';

export function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

/** Strict base64url decode: rejects padding and characters outside the alphabet. */
export function base64UrlDecode(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('invalid base64url');
  const out = Buffer.from(s, 'base64url');
  if (base64UrlEncode(out) !== s) throw new Error('non-canonical base64url');
  return new Uint8Array(out);
}

/** Strict standard base64 decode (padding required). */
export function base64Decode(s: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s)) {
    throw new Error('invalid base64');
  }
  return new Uint8Array(Buffer.from(s, 'base64'));
}

export function sha256(data: Uint8Array | string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(data).digest());
}

export function sha256Base64Url(data: Uint8Array | string): string {
  return base64UrlEncode(sha256(data));
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}
