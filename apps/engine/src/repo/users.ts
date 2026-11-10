import { and, asc, desc, eq, gt, isNull, lt } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { conversations, devices, enrollCodes, guardPolicies, users } from '../db/schema.ts';
import type { GuardPolicy } from '../guard/policy.ts';
import { newId } from '../lib/ids.ts';
import type { SpaceRef } from '../ports/messaging.ts';

export type UserRow = typeof users.$inferSelect;
export type DeviceRow = typeof devices.$inferSelect;
export type DevicePlatform = 'ios_app' | 'web_passkey';

export class UsersRepo {
  constructor(private readonly db: Db) {}

  /** A page of user ids in stable id order; pass the last id seen as `afterId`. */
  async listIds(limit = 100, afterId?: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: users.id })
      .from(users)
      .where(afterId ? gt(users.id, afterId) : undefined)
      .orderBy(asc(users.id))
      .limit(Math.min(Math.max(limit, 1), 500));
    return rows.map((r) => r.id);
  }

  async byAccountId(accountId: string): Promise<UserRow | null> {
    const [r] = await this.db.select().from(users).where(eq(users.accountId, accountId)).limit(1);
    return r ?? null;
  }

  async byId(id: string): Promise<UserRow | null> {
    const [r] = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    return r ?? null;
  }

  async findOrCreateByHandle(handle: string): Promise<UserRow> {
    const [existing] = await this.db.select().from(users).where(eq(users.handle, handle)).limit(1);
    if (existing) return existing;
    const [created] = await this.db
      .insert(users)
      .values({ id: newId('usr'), handle })
      .onConflictDoNothing()
      .returning();
    if (created) {
      await this.db.insert(guardPolicies).values({ userId: created.id }).onConflictDoNothing();
      return created;
    }
    const [raced] = await this.db.select().from(users).where(eq(users.handle, handle)).limit(1);
    if (!raced) throw new Error('user create race');
    return raced;
  }

  async setAccount(
    userId: string,
    slug: string,
    accountId: string,
    dryRun: boolean,
  ): Promise<void> {
    await this.db
      .update(users)
      .set({ slug, accountId, enrolledDryRun: dryRun })
      .where(eq(users.id, userId));
  }

  /**
   * Land a new device and its account together. Two separate writes left a
   * window where a crash enrolled the device but left account_id null, which
   * made every retry look like "already enrolled" with no account to return.
   */
  async enrollDeviceAndAccount(
    userId: string,
    publicKey: string,
    slug: string,
    accountId: string,
    dryRun: boolean,
    attest?: { keyId: string; publicKeyXY: string },
    platform: DevicePlatform = 'ios_app',
  ): Promise<DeviceRow> {
    return this.db.transaction(async (tx) => {
      const [d] = await tx
        .insert(devices)
        .values({
          id: newId('dev'),
          userId,
          publicKey,
          platform,
          hasExtension: platform === 'ios_app',
          ...(attest
            ? {
                appAttest: attest.keyId,
                appAttestKeyId: attest.keyId,
                appAttestPublicKey: attest.publicKeyXY,
                appAttestVerified: true,
              }
            : {}),
        })
        .returning();
      if (!d) throw new Error('device insert failed');
      const updated = await tx
        .update(users)
        .set({ slug, accountId, enrolledDryRun: dryRun })
        .where(eq(users.id, userId))
        .returning({ id: users.id });
      if (updated.length !== 1) throw new Error('user missing during enroll');
      return d;
    });
  }

  async deviceByPublicKey(publicKey: string): Promise<DeviceRow | null> {
    const [d] = await this.db
      .select()
      .from(devices)
      .where(eq(devices.publicKey, publicKey))
      .limit(1);
    return d ?? null;
  }

  /**
   * Replace a device's App Attest credential. A reinstall clears the cached
   * key id but keeps the Keychain device key, so a retry can carry a new
   * attestation key; assertions from then on must verify against the new one.
   */
  async refreshAttestation(
    deviceId: string,
    attest: { keyId: string; publicKeyXY: string },
  ): Promise<void> {
    await this.db
      .update(devices)
      .set({
        appAttest: attest.keyId,
        appAttestKeyId: attest.keyId,
        appAttestPublicKey: attest.publicKeyXY,
        appAttestVerified: true,
        appAttestCounter: 0,
      })
      .where(eq(devices.id, deviceId));
  }

  async deviceById(deviceId: string): Promise<DeviceRow | null> {
    const [d] = await this.db.select().from(devices).where(eq(devices.id, deviceId)).limit(1);
    return d ?? null;
  }

  /** Revoke a device: it can no longer sign or be used for approvals. */
  async revokeDevice(deviceId: string): Promise<boolean> {
    const r = await this.db
      .update(devices)
      .set({ revokedAt: new Date(), revokedReason: 'user' })
      .where(and(eq(devices.id, deviceId), isNull(devices.revokedAt)))
      .returning({ id: devices.id });
    return r.length === 1;
  }

  /**
   * Freeze: every device key for this user is revoked (reason 'freeze') and the
   * user is marked frozen. Returns the devices it revoked.
   */
  async freeze(userId: string, at: Date): Promise<DeviceRow[]> {
    return this.db.transaction(async (tx) => {
      await tx.update(users).set({ frozenAt: at }).where(eq(users.id, userId));
      return tx
        .update(devices)
        .set({ revokedAt: at, revokedReason: 'freeze' })
        .where(and(eq(devices.userId, userId), isNull(devices.revokedAt)))
        .returning();
    });
  }

  /** Devices the freeze switched off, newest first (the only ones that may unfreeze). */
  async frozenDevices(userId: string): Promise<DeviceRow[]> {
    return this.db
      .select()
      .from(devices)
      .where(and(eq(devices.userId, userId), eq(devices.revokedReason, 'freeze')))
      .orderBy(desc(devices.enrolledAt));
  }

  /** Unfreeze: clears the flag and brings back only the keys the freeze revoked. */
  async unfreeze(userId: string): Promise<string[]> {
    return this.db.transaction(async (tx) => {
      await tx.update(users).set({ frozenAt: null }).where(eq(users.id, userId));
      const r = await tx
        .update(devices)
        .set({ revokedAt: null, revokedReason: null })
        .where(and(eq(devices.userId, userId), eq(devices.revokedReason, 'freeze')))
        .returning({ id: devices.id });
      return r.map((d) => d.id);
    });
  }

  async activeDevice(userId: string): Promise<DeviceRow | null> {
    const [d] = await this.db
      .select()
      .from(devices)
      .where(and(eq(devices.userId, userId), isNull(devices.revokedAt)))
      // Enrollment allows one active device; order anyway so the pick is deterministic.
      .orderBy(desc(devices.enrolledAt), desc(devices.id))
      .limit(1);
    return d ?? null;
  }

  async addDevice(
    userId: string,
    publicKey: string,
    attest?: { keyId: string; publicKeyXY: string },
    platform: DevicePlatform = 'ios_app',
  ): Promise<DeviceRow> {
    const [d] = await this.db
      .insert(devices)
      .values({
        id: newId('dev'),
        userId,
        publicKey,
        platform,
        hasExtension: platform === 'ios_app',
        ...(attest
          ? {
              appAttest: attest.keyId,
              appAttestKeyId: attest.keyId,
              appAttestPublicKey: attest.publicKeyXY,
              appAttestVerified: true,
            }
          : {}),
      })
      .returning();
    if (!d) throw new Error('device insert failed');
    return d;
  }

  /** Advance the App Attest assertion counter (monotonic; returns false on replay). */
  async advanceAttestCounter(deviceId: string, counter: number): Promise<boolean> {
    const r = await this.db
      .update(devices)
      .set({ appAttestCounter: counter })
      .where(and(eq(devices.id, deviceId), lt(devices.appAttestCounter, counter)))
      .returning({ id: devices.id });
    return r.length === 1;
  }

  /** User-edited Guard limits (Face ID signed at the route layer). */
  async updatePolicy(
    userId: string,
    patch: Partial<{ perTxUsd: string; dailyUsd: string; blockNewRecipientsOverUsd: string }>,
  ): Promise<GuardPolicy> {
    await this.policy(userId); // ensure the row exists
    await this.db.update(guardPolicies).set(patch).where(eq(guardPolicies.userId, userId));
    return this.policy(userId);
  }

  async policy(userId: string): Promise<GuardPolicy> {
    const [p] = await this.db
      .select()
      .from(guardPolicies)
      .where(eq(guardPolicies.userId, userId))
      .limit(1);
    if (!p) {
      await this.db.insert(guardPolicies).values({ userId }).onConflictDoNothing();
      return this.policy(userId);
    }
    return {
      perTxUsd: p.perTxUsd,
      dailyUsd: p.dailyUsd,
      allowlist: p.allowlist,
      blockNewRecipientsOverUsd: p.blockNewRecipientsOverUsd,
      maxApprovalsPer10Min: p.maxApprovalsPer10Min,
    };
  }

  // ---- enroll codes (stored hashed, single use, TTL) ----

  async storeEnrollCode(codeHash: string, userId: string, handle: string, expiresAt: Date) {
    await this.db.insert(enrollCodes).values({ codeHash, userId, handle, expiresAt });
  }

  /** Atomically consume. Returns the bound user or null (unknown, used, expired). */
  /** True when an enroll code exists, unused and unexpired (challenge issuance). */
  async enrollCodeUsable(codeHash: string, now: Date): Promise<boolean> {
    const [r] = await this.db
      .select({ id: enrollCodes.codeHash })
      .from(enrollCodes)
      .where(
        and(
          eq(enrollCodes.codeHash, codeHash),
          isNull(enrollCodes.usedAt),
          gt(enrollCodes.expiresAt, now),
        ),
      )
      .limit(1);
    return Boolean(r);
  }

  /** The user a live, unused enroll code is bound to; does not consume it. */
  async enrollCodeUser(
    codeHash: string,
    now: Date,
  ): Promise<{ userId: string; handle: string } | null> {
    const [r] = await this.db
      .select({ userId: enrollCodes.userId, handle: enrollCodes.handle })
      .from(enrollCodes)
      .where(
        and(
          eq(enrollCodes.codeHash, codeHash),
          isNull(enrollCodes.usedAt),
          gt(enrollCodes.expiresAt, now),
        ),
      )
      .limit(1);
    return r ?? null;
  }

  async consumeEnrollCode(
    codeHash: string,
    now: Date,
  ): Promise<{ userId: string; handle: string } | null> {
    const [r] = await this.db
      .update(enrollCodes)
      .set({ usedAt: now })
      .where(
        and(
          eq(enrollCodes.codeHash, codeHash),
          isNull(enrollCodes.usedAt),
          gt(enrollCodes.expiresAt, now),
        ),
      )
      .returning({ userId: enrollCodes.userId, handle: enrollCodes.handle });
    return r ?? null;
  }

  // ---- conversations ----

  async conversationFor(
    userId: string,
    spaceId: string,
    platform: string,
    phone?: string | null,
  ): Promise<string> {
    const [c] = await this.db
      .select({ id: conversations.id, phone: conversations.phone })
      .from(conversations)
      .where(eq(conversations.spaceId, spaceId))
      .limit(1);
    if (c) {
      if (phone && c.phone !== phone)
        await this.db.update(conversations).set({ phone }).where(eq(conversations.id, c.id));
      return c.id;
    }
    const id = newId('cnv');
    await this.db
      .insert(conversations)
      .values({ id, userId, spaceId, platform, phone: phone ?? null })
      .onConflictDoNothing();
    const [again] = await this.db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.spaceId, spaceId))
      .limit(1);
    return again?.id ?? id;
  }

  /**
   * Where to text a user first (reminders, new-bill notes): their most recent
   * conversation with Penny. Null if they never texted.
   */
  async primarySpace(userId: string): Promise<{ conversationId: string; space: SpaceRef } | null> {
    const [row] = await this.db
      .select({
        id: conversations.id,
        spaceId: conversations.spaceId,
        phone: conversations.phone,
        handle: users.handle,
      })
      .from(conversations)
      .innerJoin(users, eq(users.id, conversations.userId))
      .where(eq(conversations.userId, userId))
      .orderBy(desc(conversations.createdAt), desc(conversations.id))
      .limit(1);
    if (!row) return null;
    return {
      conversationId: row.id,
      space: {
        spaceId: row.spaceId,
        userHandle: row.handle,
        ...(row.phone ? { phone: row.phone } : {}),
      },
    };
  }
}
