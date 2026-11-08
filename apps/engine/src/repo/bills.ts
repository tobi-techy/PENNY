import { and, asc, desc, eq, inArray, lte } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { bills, reminders } from '../db/schema.ts';
import { newId } from '../lib/ids.ts';

export type BillRow = typeof bills.$inferSelect;
export type ReminderRow = typeof reminders.$inferSelect;
export type BillStatus = BillRow['status'];

export type NewBill = Omit<BillRow, 'id' | 'userId' | 'status' | 'notifiedAt' | 'createdAt'>;

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
}

export class RemindersRepo {
  constructor(private readonly db: Db) {}

  async add(r: {
    userId: string;
    text: string;
    dueAt: Date;
    source: 'user' | 'bill';
    billId?: string | null;
  }): Promise<ReminderRow | null> {
    const [row] = await this.db
      .insert(reminders)
      .values({
        id: newId('rem'),
        userId: r.userId,
        text: r.text,
        dueAt: r.dueAt,
        source: r.source,
        billId: r.billId ?? null,
      })
      .onConflictDoNothing({ target: reminders.billId })
      .returning();
    return row ?? null;
  }

  async pending(userId: string, limit = 20): Promise<ReminderRow[]> {
    return this.db
      .select()
      .from(reminders)
      .where(and(eq(reminders.userId, userId), eq(reminders.status, 'pending')))
      .orderBy(asc(reminders.dueAt))
      .limit(Math.min(Math.max(limit, 1), 50));
  }

  async countPending(userId: string): Promise<number> {
    return (await this.pending(userId, 50)).length;
  }

  /** Pending reminders due at or before `now`, oldest first. */
  async due(now: Date, limit = 100): Promise<ReminderRow[]> {
    return this.db
      .select()
      .from(reminders)
      .where(and(eq(reminders.status, 'pending'), lte(reminders.dueAt, now)))
      .orderBy(asc(reminders.dueAt))
      .limit(limit);
  }

  /**
   * Claim a due reminder before sending (CAS pending -> sent), so two ticks or
   * two instances never text the same reminder twice.
   */
  async claim(id: string, at: Date): Promise<boolean> {
    const r = await this.db
      .update(reminders)
      .set({ status: 'sent', sentAt: at })
      .where(and(eq(reminders.id, id), eq(reminders.status, 'pending')))
      .returning({ id: reminders.id });
    return r.length === 1;
  }

  async markFailed(id: string): Promise<void> {
    await this.db.update(reminders).set({ status: 'failed' }).where(eq(reminders.id, id));
  }

  async cancel(userId: string, id: string): Promise<boolean> {
    const r = await this.db
      .update(reminders)
      .set({ status: 'cancelled' })
      .where(
        and(eq(reminders.id, id), eq(reminders.userId, userId), eq(reminders.status, 'pending')),
      )
      .returning({ id: reminders.id });
    return r.length === 1;
  }

  async cancelForBill(billId: string): Promise<void> {
    await this.db
      .update(reminders)
      .set({ status: 'cancelled' })
      .where(and(eq(reminders.billId, billId), eq(reminders.status, 'pending')));
  }
}
