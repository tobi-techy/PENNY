import { baseDecode, baseEncode } from '@near-js/utils';

const B64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const B64URL_RE = /^[A-Za-z0-9_-]*$/;

export class EncodingError extends Error {
  override name = 'EncodingError';
}

/** Strict standard base64 (padded). Rejects whitespace and url-safe chars. */
export function fromBase64(s: string): Uint8Array {
  if (s.length === 0 || !B64_RE.test(s)) throw new EncodingError('invalid base64');
  return new Uint8Array(Buffer.from(s, 'base64'));
}

export function toBase64(b: Uint8Array): string {
  return Buffer.from(b).toString('base64');
}

/** Unpadded base64url (RFC 4648 §5). */
export function fromBase64Url(s: string): Uint8Array {
  if (!B64URL_RE.test(s) || s.length % 4 === 1) throw new EncodingError('invalid base64url');
  return new Uint8Array(Buffer.from(s, 'base64url'));
}

export function toBase64Url(b: Uint8Array): string {
  return Buffer.from(b).toString('base64url');
}

export function toBase58(b: Uint8Array): string {
  return baseEncode(b);
}

export function fromBase58(s: string): Uint8Array {
  try {
    return baseDecode(s);
  } catch {
    throw new EncodingError('invalid base58');
  }
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export const utf8 = {
  encode: (s: string): Uint8Array => new TextEncoder().encode(s),
  decode: (b: Uint8Array): string => new TextDecoder('utf-8', { fatal: true }).decode(b),
};
