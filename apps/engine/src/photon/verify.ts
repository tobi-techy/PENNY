import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Spectrum webhook signature check, exactly per
 * https://photon.codes/docs/webhooks/verifying-signatures.md (Stable):
 *   sig = 'v0=' + hex(HMAC-SHA256(secret, 'v0:' + timestamp + ':' + rawBody))
 *   lowercase hex, 5-minute tolerance, constant-time compare, raw body bytes.
 * Missing headers / stale timestamp -> 400; bad signature -> 401 (both fatal
 * to Photon's retry worker, per delivery.md).
 */

export const TOLERANCE_SEC = 5 * 60;

export type VerifyOutcome =
  | { ok: true }
  | {
      ok: false;
      status: 400 | 401;
      reason: 'missing_headers' | 'stale_timestamp' | 'bad_signature';
    };

export function signSpectrum(secret: string, timestamp: string, rawBody: string): string {
  return `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`;
}

export function verifySpectrumSignature(input: {
  secret: string;
  rawBody: string;
  timestamp: string | undefined;
  signature: string | undefined;
  nowSec?: number;
}): VerifyOutcome {
  const { secret, rawBody, timestamp, signature } = input;
  if (!timestamp || !signature) return { ok: false, status: 400, reason: 'missing_headers' };
  if (!/^\d{1,12}$/.test(timestamp)) return { ok: false, status: 400, reason: 'stale_timestamp' };
  const now = input.nowSec ?? Math.floor(Date.now() / 1000);
  const age = Math.abs(now - Number(timestamp));
  if (!Number.isFinite(age) || age > TOLERANCE_SEC) {
    return { ok: false, status: 400, reason: 'stale_timestamp' };
  }
  const expected = Buffer.from(signSpectrum(secret, timestamp, rawBody));
  const got = Buffer.from(signature);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) {
    return { ok: false, status: 401, reason: 'bad_signature' };
  }
  return { ok: true };
}
