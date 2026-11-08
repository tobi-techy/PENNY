import { and, asc, eq, isNull, lte } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { cards, passkeys, reminders } from '../db/schema.ts';
import { newId } from '../lib/ids.ts';

export type CardRow = typeof cards.$inferSelect;
export type NewCardRow = typeof cards.$inferInsert;
export type PasskeyRow = typeof passkeys.$inferSelect;
export type ReminderRow = typeof reminders.$inferSelect;

export class CardsRepo {
  constructor(private readonly db: Db) {}

  async create(row: Omit<NewCardRow, 'id'> & { id?: string }): Promise<CardRow> {
    const [r] = await this.db
      .insert(cards)
      .values({ ...row, id: row.id ?? newId('crd') })
      .returning();
    if (!r) throw new Error('card insert failed');
    return r;
  }

  async get(id: string): Promise<CardRow | null> {
    const [r] = await this.db.select().from(cards).where(eq(cards.id, id)).limit(1);
    return r ?? null;
  }

  async byTokenHash(hash: string): Promise<CardRow | null> {
    const [r] = await this.db.select().from(cards).where(eq(cards.tokenHash, hash)).limit(1);
    return r ?? null;
  }

  async byApprovalId(approvalId: string): Promise<CardRow | null> {
    const [r] = await this.db.select().from(cards).where(eq(cards.approvalId, approvalId)).limit(1);
    return r ?? null;
  }

  /** info -> approval, exactly once (a second Send press gets false). */
  async claimForApproval(id: string): Promise<boolean> {
    const r = await this.db
      .update(cards)
      .set({ kind: 'approval', updatedAt: new Date() })
      .where(and(eq(cards.id, id), eq(cards.kind, 'info')))
      .returning({ id: cards.id });
    return r.length === 1;
  }

  async update(
    id: string,
    patch: Partial<
      Pick<
        CardRow,
        | 'state'
        | 'title'
        | 'amount'
        | 'lines'
        | 'buttons'
        | 'kind'
        | 'type'
        | 'approvalId'
        | 'payload'
        | 'receiptUrl'
        | 'expiresAt'
        | 'tokenExpiresAt'
        | 'messageRef'
      >
    >,
  ): Promise<CardRow | null> {
    const [r] = await this.db
      .update(cards)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(cards.id, id))
      .returning();
    return r ?? null;
  }
}

export class PasskeysRepo {
  constructor(private readonly db: Db) {}

  async create(row: {
    userId: string;
    deviceId: string;
    credentialId: string;
    publicKey: string;
    signCount: number;
    transports: string[];
  }): Promise<PasskeyRow> {
    const [r] = await this.db
      .insert(passkeys)
      .values({ id: newId('pky'), ...row })
      .returning();
    if (!r) throw new Error('passkey insert failed');
    return r;
  }

  async activeForUser(userId: string): Promise<PasskeyRow[]> {
    return this.db
      .select()
      .from(passkeys)
      .where(and(eq(passkeys.userId, userId), isNull(passkeys.revokedAt)));
  }

  async byCredentialId(credentialId: string): Promise<PasskeyRow | null> {
    const [r] = await this.db
      .select()
      .from(passkeys)
      .where(eq(passkeys.credentialId, credentialId))
      .limit(1);
    return r ?? null;
  }

  /**
   * Store the new sign count only if it did not go backwards (compare-and-set),
   * so two racing assertions cannot both move it.
   */
  async advanceCount(id: string, from: number, to: number): Promise<boolean> {
    const r = await this.db
      .update(passkeys)
      .set({ signCount: to })
      .where(and(eq(passkeys.id, id), eq(passkeys.signCount, from)))
      .returning({ id: passkeys.id });
    return r.length === 1;
  }

  async revokeForUser(userId: string, at: Date): Promise<number> {
    const r = await this.db
      .update(passkeys)
      .set({ revokedAt: at })
      .where(and(eq(passkeys.userId, userId), isNull(passkeys.revokedAt)))
      .returning({ id: passkeys.id });
    return r.length;
  }

  async restoreForDevices(deviceIds: string[]): Promise<void> {
    for (const deviceId of deviceIds) {
      await this.db
        .update(passkeys)
        .set({ revokedAt: null })
        .where(eq(passkeys.deviceId, deviceId));
    }
  }
}

export class RemindersRepo {
  constructor(private readonly db: Db) {}

  async create(row: {
    userId: string;
    text: string;
    dueAt: Date;
    space: { spaceId: string; phone?: string; userHandle: string };
  }): Promise<ReminderRow> {
    const [r] = await this.db
      .insert(reminders)
      .values({ id: newId('rmd'), ...row })
      .returning();
    if (!r) throw new Error('reminder insert failed');
    return r;
  }

  /** One reminder per bill: a second call for the same bill is a no-op (null). */
  async createForBill(row: {
    userId: string;
    billId: string;
    text: string;
    dueAt: Date;
    space: { spaceId: string; phone?: string; userHandle: string };
  }): Promise<ReminderRow | null> {
    const [r] = await this.db
      .insert(reminders)
      .values({ id: newId('rmd'), source: 'bill', ...row })
      .onConflictDoNothing({ target: reminders.billId })
      .returning();
    return r ?? null;
  }

  /** Upcoming reminders for a user, soonest first. */
  async scheduled(userId: string, limit = 20): Promise<ReminderRow[]> {
    return this.db
      .select()
      .from(reminders)
      .where(and(eq(reminders.userId, userId), eq(reminders.status, 'scheduled')))
      .orderBy(asc(reminders.dueAt))
      .limit(Math.min(Math.max(limit, 1), 50));
  }

  /** Undo a user's own scheduled reminder (scheduled -> undone). */
  async undoForUser(userId: string, id: string): Promise<boolean> {
    const r = await this.db
      .update(reminders)
      .set({ status: 'undone' })
      .where(
        and(eq(reminders.id, id), eq(reminders.userId, userId), eq(reminders.status, 'scheduled')),
      )
      .returning({ id: reminders.id });
    return r.length === 1;
  }

  async undoForBill(billId: string): Promise<void> {
    await this.db
      .update(reminders)
      .set({ status: 'undone' })
      .where(and(eq(reminders.billId, billId), eq(reminders.status, 'scheduled')));
  }

  async markFailed(id: string): Promise<void> {
    await this.db.update(reminders).set({ status: 'failed' }).where(eq(reminders.id, id));
  }

  async get(id: string): Promise<ReminderRow | null> {
    const [r] = await this.db.select().from(reminders).where(eq(reminders.id, id)).limit(1);
    return r ?? null;
  }

  async setCard(id: string, cardId: string): Promise<void> {
    await this.db.update(reminders).set({ cardId }).where(eq(reminders.id, id));
  }

  /** scheduled -> undone. False when it already fired or was undone. */
  async undo(id: string): Promise<boolean> {
    const r = await this.db
      .update(reminders)
      .set({ status: 'undone' })
      .where(and(eq(reminders.id, id), eq(reminders.status, 'scheduled')))
      .returning({ id: reminders.id });
    return r.length === 1;
  }

  async due(now: Date, limit = 100): Promise<ReminderRow[]> {
    return this.db
      .select()
      .from(reminders)
      .where(and(eq(reminders.status, 'scheduled'), lte(reminders.dueAt, now)))
      .orderBy(asc(reminders.dueAt))
      .limit(limit);
  }

  /** scheduled -> sent, exactly once. */
  async markSent(id: string): Promise<boolean> {
    const r = await this.db
      .update(reminders)
      .set({ status: 'sent' })
      .where(and(eq(reminders.id, id), eq(reminders.status, 'scheduled')))
      .returning({ id: reminders.id });
    return r.length === 1;
  }
}
