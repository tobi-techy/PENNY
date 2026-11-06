import { ENROLL_CODE_ALPHABET, type EnrollBody } from '@penny/shared';
import { randomCode, sha256Hex } from '../lib/crypto.ts';
import type { ChainPort } from '../ports/chain.ts';
import type { AttestChallengesRepo } from '../repo/infra.ts';
import type { UsersRepo } from '../repo/users.ts';
import { AttestError, verifyAttestation } from './appattest.ts';

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

export type AttestConfig = {
  /** "TEAMID.bundle.id" for App Attest. Required to verify any attestation. */
  appId?: string;
  /** Mainnet: enrollment without a verified attestation is refused. */
  require: boolean;
  challenges?: AttestChallengesRepo;
};

export class EnrollService {
  constructor(
    private readonly users: UsersRepo,
    private readonly chain: ChainPort,
    private readonly now: () => Date,
    private readonly attest: AttestConfig = { require: false },
  ) {}

  /** Issue a single-use App Attest challenge bound to a live enroll code. */
  async issueAttestChallenge(
    enrollCode: string,
  ): Promise<{ challengeId: string; challenge: string } | null> {
    if (!this.attest.challenges) return null;
    const codeHash = sha256Hex(enrollCode);
    if (!(await this.users.enrollCodeUsable(codeHash, this.now()))) return null;
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const challenge = Buffer.from(bytes).toString('base64url');
    const challengeId = await this.attest.challenges.create(
      codeHash,
      challenge,
      new Date(this.now().getTime() + 5 * 60_000),
    );
    return { challengeId, challenge };
  }

  /** One-time 8-char code, bound to the iMessage handle, stored hashed, 10 min TTL. */
  async issue(userId: string, handle: string): Promise<{ code: string; expiresAt: Date }> {
    const code = randomCode(8, ENROLL_CODE_ALPHABET);
    const expiresAt = new Date(this.now().getTime() + ENROLL_TTL_MS);
    await this.users.storeEnrollCode(sha256Hex(code), userId, handle, expiresAt);
    return { code, expiresAt };
  }

  async enroll(body: EnrollBody): Promise<{
    userId: string;
    accountId: string;
    deviceId: string;
    status: 'created' | 'dry_run';
  }> {
    const pk = Buffer.from(body.publicKeyEd25519, 'base64url');
    if (pk.length !== 32) throw new EnrollError(400, 'bad_public_key');
    const codeHash = sha256Hex(body.enrollCode);
    // App Attest is verified BEFORE the enroll code or account is consumed,
    // so a bad attestation never burns a code or creates an account.
    let verified: { keyId: string; publicKeyXY: string } | undefined;
    if (body.appAttest) {
      if (!this.attest.appId || !this.attest.challenges || !body.appAttestChallengeId) {
        throw new EnrollError(502, 'attest_unconfigured');
      }
      const challenge = await this.attest.challenges.consume(
        body.appAttestChallengeId,
        codeHash,
        this.now(),
      );
      if (!challenge) throw new EnrollError(401, 'attest_challenge_invalid');
      try {
        const att = verifyAttestation({
          attestationB64: body.appAttest,
          challenge,
          appId: this.attest.appId,
        });
        // Mainnet (attestation required) accepts production attestations only;
        // a development build signed with our team id must not enroll there.
        if (this.attest.require && att.environment !== 'production') {
          throw new AttestError('environment');
        }
        verified = { keyId: att.keyId, publicKeyXY: att.publicKeyXY };
      } catch (e) {
        if (e instanceof AttestError) throw new EnrollError(401, `attest_${e.code}`);
        throw e;
      }
    } else if (this.attest.require) {
      throw new EnrollError(401, 'attest_required');
    }
    const claim = await this.users.consumeEnrollCode(codeHash, this.now());
    // unknown, used and expired all look the same
    if (!claim) throw new EnrollError(401, 'invalid_code');
    if (await this.users.activeDevice(claim.userId)) throw new EnrollError(409, 'already_enrolled');
    const slug = newSlug();
    const created = await this.chain.createUserAccount(slug, body.publicKeyEd25519);
    if (!created.ok) throw new EnrollError(502, 'account_create_failed');
    const device = await this.users.addDevice(claim.userId, body.publicKeyEd25519, verified);
    await this.users.setAccount(claim.userId, slug, created.accountId);
    return {
      userId: claim.userId,
      accountId: created.accountId,
      deviceId: device.id,
      status: created.dryRun ? 'dry_run' : 'created',
    };
  }
}
