import type { ApprovalKind, ApprovalStatus } from '@penny/shared';
import { and, asc, desc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import { assertTransition } from '../approvals/state.ts';
import type { Db } from '../db/client.ts';
import { approvalEvents, approvals } from '../db/schema.ts';
import { newId } from '../lib/ids.ts';

export type ApprovalRow = typeof approvals.$inferSelect;
export type NewApprovalRow = typeof approvals.$inferInsert;

export class ConcurrentTransitionError extends Error {
  override name = 'ConcurrentTransitionError';
}

export class ApprovalsRepo {
  constructor(
    private readonly db: Db,
    /** Injected clock so timestamps match the engine's clock (and tests can move time). */
    private readonly now: () => Date = () => new Date(),
  ) {}

  async create(row: NewApprovalRow): Promise<ApprovalRow> {
    return this.db.transaction(async (tx) => {
      const [created] = await tx.insert(approvals).values(row).returning();
      if (!created) throw new Error('insert failed');
      await tx.insert(approvalEvents).values({
        id: newId('evt'),
        approvalId: created.id,
        fromStatus: null,
        toStatus: created.status,
        reason: 'created',
      });
      return created;
    });
  }

  async get(id: string): Promise<ApprovalRow | null> {
    const [r] = await this.db.select().from(approvals).where(eq(approvals.id, id)).limit(1);
    return r ?? null;
  }

  /** Remember where the live card lives, so it can be edited after a restart. */
  async setCardHandle(
    id: string,
    ref: string,
    space: { spaceId: string; userHandle: string; phone?: string; baseUrl?: string },
  ): Promise<void> {
    await this.db
      .update(approvals)
      .set({ cardRef: ref, cardSpace: space })
      .where(eq(approvals.id, id));
  }

  /**
   * Compare-and-set transition. Fails if the row moved underneath us, which is
   * what makes approvals single-use under concurrent submits.
   */
  async transition(
    id: string,
    kind: ApprovalKind,
    from: ApprovalStatus,
    to: ApprovalStatus,
    reason: string,
    patch: Partial<Pick<ApprovalRow, 'txHash'>> = {},
    meta?: Record<string, unknown>,
  ): Promise<ApprovalRow> {
    assertTransition(from, to, kind);
    return this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(approvals)
        .set({ status: to, updatedAt: this.now(), ...patch })
        .where(and(eq(approvals.id, id), eq(approvals.status, from)))
        .returning();
      if (!updated) throw new ConcurrentTransitionError(`approval ${id} is no longer ${from}`);
      await tx.insert(approvalEvents).values({
        id: newId('evt'),
        approvalId: id,
        fromStatus: from,
        toStatus: to,
        reason,
        meta: meta ?? null,
      });
      return updated;
    });
  }

  /**
   * Burn the single-use challenge. Only the first attempt on a pending approval
   * wins; every later attempt (replay, race, retry) gets false.
   */
  async burnChallenge(id: string, now: Date): Promise<boolean> {
    const r = await this.db
      .update(approvals)
      .set({ challengeUsedAt: now })
      .where(
        and(
          eq(approvals.id, id),
          eq(approvals.status, 'pending'),
          isNull(approvals.challengeUsedAt),
        ),
      )
      .returning({ id: approvals.id });
    return r.length === 1;
  }

  async setCardId(id: string, cardId: string): Promise<void> {
    await this.db.update(approvals).set({ cardId }).where(eq(approvals.id, id));
  }

  async byReissuedFrom(id: string): Promise<ApprovalRow | null> {
    const [r] = await this.db
      .select()
      .from(approvals)
      .where(eq(approvals.reissuedFrom, id))
      .limit(1);
    return r ?? null;
  }

  /** Approvals still waiting on the user (freeze expires these). */
  async pendingForUser(userId: string): Promise<ApprovalRow[]> {
    return this.db
      .select()
      .from(approvals)
      .where(and(eq(approvals.userId, userId), eq(approvals.status, 'pending')))
      .limit(500);
  }

  async events(approvalId: string) {
    return this.db
      .select()
      .from(approvalEvents)
      .where(eq(approvalEvents.approvalId, approvalId))
      .orderBy(approvalEvents.seq);
  }

  /** Recent approvals for the host-app history screen, newest first. */
  async listForUser(userId: string, limit = 20): Promise<ApprovalRow[]> {
    return this.db
      .select()
      .from(approvals)
      .where(eq(approvals.userId, userId))
      .orderBy(desc(approvals.createdAt))
      .limit(Math.min(Math.max(limit, 1), 50));
  }

  /** Approvals waiting on chain confirmation (status poller input). */
  async relayed(limit = 50): Promise<ApprovalRow[]> {
    return this.db.select().from(approvals).where(eq(approvals.status, 'relayed')).limit(limit);
  }

  /**
   * Approvals created in the window that still count toward velocity. Terminal
   * outcomes (declined, expired, failed, cancelled) are excluded: five declines in
   * ten minutes should not lock the user out of their sixth attempt.
   */
  async countCreatedSince(userId: string, since: Date): Promise<number> {
    const [r] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(approvals)
      .where(
        and(
          eq(approvals.userId, userId),
          gte(approvals.createdAt, since),
          inArray(approvals.status, ['pending', 'signed', 'relayed', 'settled']),
        ),
      );
    return r?.n ?? 0;
  }

  async pendingExpiredBefore(now: Date): Promise<ApprovalRow[]> {
    return (
      this.db
        .select()
        .from(approvals)
        .where(and(eq(approvals.status, 'pending'), lt(approvals.expiresAt, now)))
        // Oldest first. Newest-first meant that once more than `limit` rows were
        // overdue, the oldest ones fell off the end of every sweep and were never
        // released, leaking their ledger reservation into the rolling 24h window.
        .orderBy(asc(approvals.expiresAt))
        .limit(500)
    );
  }

  /**
   * Approvals stuck in `signed`: the device signature verified and the CAS moved the
   * row, but the relay never reported back (a throw, a crash, a redeploy). Nothing
   * else sweeps this state, so without it the ledger reservation is held forever.
   */
  async signedOlderThan(cutoff: Date, limit = 100): Promise<ApprovalRow[]> {
    return this.db
      .select()
      .from(approvals)
      .where(and(eq(approvals.status, 'signed'), lt(approvals.updatedAt, cutoff)))
      .orderBy(asc(approvals.updatedAt))
      .limit(limit);
  }
}
