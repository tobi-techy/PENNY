import type { ApprovalKind, ApprovalStatus } from '@penny/shared';
import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
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
  constructor(private readonly db: Db) {}

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
        .set({ status: to, updatedAt: new Date(), ...patch })
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

  async events(approvalId: string) {
    return this.db
      .select()
      .from(approvalEvents)
      .where(eq(approvalEvents.approvalId, approvalId))
      .orderBy(approvalEvents.createdAt, approvalEvents.id);
  }

  async countCreatedSince(userId: string, since: Date): Promise<number> {
    const [r] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(approvals)
      .where(and(eq(approvals.userId, userId), gte(approvals.createdAt, since)));
    return r?.n ?? 0;
  }

  async pendingExpiredBefore(now: Date): Promise<ApprovalRow[]> {
    return this.db
      .select()
      .from(approvals)
      .where(and(eq(approvals.status, 'pending'), lt(approvals.expiresAt, now)))
      .orderBy(desc(approvals.expiresAt))
      .limit(500);
  }
}
