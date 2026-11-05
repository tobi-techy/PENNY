import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { conversations, devices, enrollCodes, guardPolicies, users } from '../db/schema.ts';
import type { GuardPolicy } from '../guard/policy.ts';
import { newId } from '../lib/ids.ts';

export type UserRow = typeof users.$inferSelect;
export type DeviceRow = typeof devices.$inferSelect;

export class UsersRepo {
  constructor(private readonly db: Db) {}

  async listIds(limit = 100): Promise<string[]> {
    const rows = await this.db
      .select({ id: users.id })
      .from(users)
      .limit(Math.min(Math.max(limit, 1), 500));
    return rows.map((r) => r.id);
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

  async setAccount(userId: string, slug: string, accountId: string): Promise<void> {
    await this.db.update(users).set({ slug, accountId }).where(eq(users.id, userId));
  }

  async activeDevice(userId: string): Promise<DeviceRow | null> {
    const [d] = await this.db
      .select()
      .from(devices)
      .where(and(eq(devices.userId, userId), isNull(devices.revokedAt)))
      .limit(1);
    return d ?? null;
  }

  async addDevice(userId: string, publicKey: string, appAttest?: string): Promise<DeviceRow> {
    const [d] = await this.db
      .insert(devices)
      .values({ id: newId('dev'), userId, publicKey, appAttest: appAttest ?? null })
      .returning();
    if (!d) throw new Error('device insert failed');
    return d;
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

  async conversationFor(userId: string, spaceId: string, platform: string): Promise<string> {
    const [c] = await this.db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.spaceId, spaceId))
      .limit(1);
    if (c) return c.id;
    const id = newId('cnv');
    await this.db
      .insert(conversations)
      .values({ id, userId, spaceId, platform })
      .onConflictDoNothing();
    const [again] = await this.db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.spaceId, spaceId))
      .limit(1);
    return again?.id ?? id;
  }
}
