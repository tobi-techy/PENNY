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

export type EnrollResult = {
  userId: string;
  accountId: string;
  deviceId: string;
  status: 'created' | 'dry_run';
};

/** Compare decoded key bytes: base64url accepts encodings that differ in pad bits. */
function samePublicKey(a: string, b: string): boolean {
  const x = Buffer.from(a, 'base64url');
  const y = Buffer.from(b, 'base64url');
  return x.length === 32 && y.length === 32 && x.equals(y);
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

  async enroll(body: EnrollBody): Promise<EnrollResult> {
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
    // Peek first: a rejected retry (different key, revoked key) must not burn
    // the code the phone still needs.
    const claim = await this.users.enrollCodeUser(codeHash, this.now());
    // unknown, used and expired all look the same
    if (!claim) throw new EnrollError(401, 'invalid_code');

    const existing = await this.users.activeDevice(claim.userId);
    if (existing) {
      if (!samePublicKey(existing.publicKey, body.publicKeyEd25519)) {
        // A different key is a second device, which enrollment does not allow.
        throw new EnrollError(409, 'already_enrolled');
      }
      // Retry of an enroll that already landed (response lost, app killed):
      // the same device key with a fresh code gets the same enrollment back,
      // including the original status (a dry-run enroll stays dry-run).
      await this.users.consumeEnrollCode(codeHash, this.now());
      // A reinstall clears the App Attest key id cache but keeps the Keychain
      // device key, so the retry may carry a new attestation key. Assertions
      // must verify against the key the phone will actually use.
      if (verified && verified.keyId !== existing.appAttestKeyId) {
        await this.users.refreshAttestation(existing.id, verified);
      }
      const user = await this.users.byId(claim.userId);
      if (user?.accountId) {
        return {
          userId: claim.userId,
          accountId: user.accountId,
          deviceId: existing.id,
          status: user.enrolledDryRun ? 'dry_run' : 'created',
        };
      }
      // The device landed but the account write never did (a crash between the
      // two old statements). Finish it with the key the device already holds.
      const slug = newSlug();
      const created = await this.chain.createUserAccount(slug, body.publicKeyEd25519);
      if (!created.ok) throw new EnrollError(502, 'account_create_failed');
      await this.users.setAccount(claim.userId, slug, created.accountId, created.dryRun);
      return {
        userId: claim.userId,
        accountId: created.accountId,
        deviceId: existing.id,
        status: created.dryRun ? 'dry_run' : 'created',
      };
    }

    // A revoked key never silently comes back: revocation is how a lost phone
    // is cut off. Say so without burning the code, so the app can rotate its
    // local key and retry with the same code.
    const prior = await this.users.deviceByPublicKey(body.publicKeyEd25519);
    if (prior) {
      throw new EnrollError(
        409,
        prior.userId === claim.userId ? 'key_revoked' : 'already_enrolled',
      );
    }

    const consumed = await this.users.consumeEnrollCode(codeHash, this.now());
    if (!consumed) throw new EnrollError(401, 'invalid_code');

    const slug = newSlug();
    const created = await this.chain.createUserAccount(slug, body.publicKeyEd25519);
    if (!created.ok) throw new EnrollError(502, 'account_create_failed');
    // Device + account land together: no crash can leave a device with no
    // account for a retry to get stuck on.
    const device = await this.users.enrollDeviceAndAccount(
      claim.userId,
      body.publicKeyEd25519,
      slug,
      created.accountId,
      created.dryRun,
      verified,
    );
    return {
      userId: claim.userId,
      accountId: created.accountId,
      deviceId: device.id,
      status: created.dryRun ? 'dry_run' : 'created',
    };
  }
}
