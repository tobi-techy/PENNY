import { ENROLL_CODE_ALPHABET, type EnrollBody } from '@penny/shared';
import { randomCode, sha256Hex } from '../lib/crypto.ts';
import type { ChainPort } from '../ports/chain.ts';
import type { UsersRepo } from '../repo/users.ts';

export const ENROLL_TTL_MS = 10 * 60_000;

export class EnrollError extends Error {
  override name = 'EnrollError';
  constructor(
    readonly status: 400 | 401 | 409 | 502,
    readonly code: string,
  ) {
    super(code);
  }
}

/** Slug for <slug>.penny.near. Random, lowercase, no PII. User-chosen names can come later. */
export function newSlug(): string {
  return `p${randomCode(9, 'abcdefghjkmnpqrstvwxyz23456789')}`;
}

export class EnrollService {
  constructor(
    private readonly users: UsersRepo,
    private readonly chain: ChainPort,
    private readonly now: () => Date,
  ) {}

  /** One-time 8-char code, bound to the iMessage handle, stored hashed, 10 min TTL. */
  async issue(userId: string, handle: string): Promise<{ code: string; expiresAt: Date }> {
    const code = randomCode(8, ENROLL_CODE_ALPHABET);
    const expiresAt = new Date(this.now().getTime() + ENROLL_TTL_MS);
    await this.users.storeEnrollCode(sha256Hex(code), userId, handle, expiresAt);
    return { code, expiresAt };
  }

  async enroll(
    body: EnrollBody,
  ): Promise<{ userId: string; accountId: string; status: 'created' | 'dry_run' }> {
    const pk = Buffer.from(body.publicKeyEd25519, 'base64url');
    if (pk.length !== 32) throw new EnrollError(400, 'bad_public_key');
    const claim = await this.users.consumeEnrollCode(sha256Hex(body.enrollCode), this.now());
    // unknown, used and expired all look the same
    if (!claim) throw new EnrollError(401, 'invalid_code');
    if (await this.users.activeDevice(claim.userId)) throw new EnrollError(409, 'already_enrolled');
    const slug = newSlug();
    const created = await this.chain.createUserAccount(slug, body.publicKeyEd25519);
    if (!created.ok) throw new EnrollError(502, 'account_create_failed');
    await this.users.addDevice(claim.userId, body.publicKeyEd25519, body.appAttest);
    await this.users.setAccount(claim.userId, slug, created.accountId);
    return {
      userId: claim.userId,
      accountId: created.accountId,
      status: created.dryRun ? 'dry_run' : 'created',
    };
  }
}
