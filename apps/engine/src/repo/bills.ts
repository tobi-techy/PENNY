import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { bills } from '../db/schema.ts';
import { newId } from '../lib/ids.ts';

export type BillRow = typeof bills.$inferSelect;
export type BillStatus = BillRow['status'];

export type NewBill = Omit<
  BillRow,
  'id' | 'userId' | 'status' | 'notifiedAt' | 'commitmentId' | 'createdAt'
>;

export class BillsRepo {
  constructor(private readonly db: Db) {}

  /** Insert bills not seen before (by source key). Returns only the newly inserted rows. */
  async addNew(userId: string, rows: NewBill[], notifiedAt: Date | null): Promise<BillRow[]> {
    if (!rows.length) return [];
    return this.db
      .insert(bills)
      .values(rows.map((r) => ({ ...r, id: newId('bil'), userId, notifiedAt })))
      .onConflictDoNothing({ target: [bills.userId, bills.sourceKey] })
      .returning();
  }

  async get(userId: string, id: string): Promise<BillRow | null> {
    const [r] = await this.db
      .select()
      .from(bills)
      .where(and(eq(bills.id, id), eq(bills.userId, userId)))
      .limit(1);
    return r ?? null;
  }

  /** Open bills, soonest due first (no due date last), then newest. */
  async open(userId: string, limit = 20): Promise<BillRow[]> {
    const rows = await this.db
      .select()
      .from(bills)
      .where(and(eq(bills.userId, userId), eq(bills.status, 'open')))
      .orderBy(desc(bills.receivedAt), desc(bills.id))
      .limit(Math.min(Math.max(limit, 1), 50));
    return rows.sort((a, b) => (a.dueOn ?? '9999').localeCompare(b.dueOn ?? '9999'));
  }

  /** CAS from open. Returns null when the bill is not open (or not this user's). */
  async close(userId: string, id: string, to: 'paid' | 'dismissed'): Promise<BillRow | null> {
    const [r] = await this.db
      .update(bills)
      .set({ status: to })
      .where(and(eq(bills.id, id), eq(bills.userId, userId), eq(bills.status, 'open')))
      .returning();
    return r ?? null;
  }

  async markNotified(ids: string[], at: Date): Promise<void> {
    if (!ids.length) return;
    await this.db.update(bills).set({ notifiedAt: at }).where(inArray(bills.id, ids));
  }

  /** Attach a bill to its recurring commitment once; never re-points a linked bill. */
  async linkCommitment(userId: string, id: string, commitmentId: string): Promise<void> {
    await this.db
      .update(bills)
      .set({ commitmentId })
      .where(and(eq(bills.id, id), eq(bills.userId, userId), isNull(bills.commitmentId)));
  }

  /** Open bills the user has not been told about yet (a failed text is retried). */
  async unnotified(userId: string, limit = 50): Promise<BillRow[]> {
    return this.db
      .select()
      .from(bills)
      .where(and(eq(bills.userId, userId), eq(bills.status, 'open'), isNull(bills.notifiedAt)))
      .orderBy(desc(bills.receivedAt), desc(bills.id))
      .limit(Math.min(Math.max(limit, 1), 100));
  }
}
