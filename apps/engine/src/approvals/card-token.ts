import { constantTimeEqual, randomToken, sha256Hex } from '../lib/crypto.ts';

/**
 * cardToken: 32 random bytes (base64url), only the sha256 is stored.
 * Bound to one approval row (and thus one user). TTL = approval expiry for
 * mutations. Reads (GET approval/status) get a grace window so the live card
 * can still show "settled" after the quote expiry. PROPOSED in report.
 */
export const READ_GRACE_MS = 15 * 60_000;

export function issueCardToken(): { token: string; hash: string } {
  const token = randomToken(32);
  return { token, hash: sha256Hex(token) };
}

export function parseCardAuth(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Card ([A-Za-z0-9_-]{43})$/.exec(header.trim());
  return m ? (m[1] as string) : null;
}

export type CardCheck = 'ok' | 'missing' | 'invalid' | 'expired';

export function checkCardToken(input: {
  token: string | null;
  storedHash: string;
  expiresAt: Date;
  now: Date;
  mode: 'read' | 'mutate';
}): CardCheck {
  if (!input.token) return 'missing';
  // hash first so the comparison is over fixed-length hex
  if (!constantTimeEqual(sha256Hex(input.token), input.storedHash)) return 'invalid';
  const limit = input.expiresAt.getTime() + (input.mode === 'read' ? READ_GRACE_MS : 0);
  if (input.now.getTime() > limit) return 'expired';
  return 'ok';
}
