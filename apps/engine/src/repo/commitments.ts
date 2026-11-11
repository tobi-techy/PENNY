import { and, asc, desc, eq, gt, isNull, lte, ne, or } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { commitmentEvents, commitments } from '../db/schema.ts';
import { newId } from '../lib/ids.ts';

export type CommitmentRow = typeof commitments.$inferSelect;
export type Cadence = NonNullable<CommitmentRow['cadence']>;
export type CommitmentStatus = CommitmentRow['status'];
export type CommitmentEventKind = typeof commitmentEvents.$inferSelect.kind;

export type NewCommitment = Omit<CommitmentRow, 'id' | 'status' | 'createdAt' | 'updatedAt'>;

export class CommitmentsRepo {
  constructor(private readonly db: Db) {}

  async byKey(userId: string, key: string): Promise<CommitmentRow | null> {
    const [r] = await this.db
      .select()
      .from(commitments)
      .where(and(eq(commitments.userId, userId), eq(commitments.key, key)))
      .limit(1);
    return r ?? null;
  }

  async get(userId: string, id: string): Promise<CommitmentRow | null> {
    const [r] = await this.db
      .select()
      .from(commitments)
      .where(and(eq(commitments.id, id), eq(commitments.userId, userId)))
      .limit(1);
    return r ?? null;
  }

  /** Insert, or return the row that won a concurrent insert for the same key. */
  async create(row: NewCommitment): Promise<CommitmentRow> {
    const [inserted] = await this.db
      .insert(commitments)
      .values({ ...row, id: newId('cmt') })
      .onConflictDoNothing({ target: [commitments.userId, commitments.key] })
      .returning();
    if (inserted) return inserted;
    const existing = await this.byKey(row.userId, row.key);
    if (!existing) throw new Error('commitment insert lost its race and the row is missing');
    return existing;
  }

  async update(id: string, patch: Partial<Omit<CommitmentRow, 'id' | 'userId'>>): Promise<void> {
    await this.db
      .update(commitments)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(commitments.id, id));
  }

  /** Active commitments, soonest expected first, then most recently seen. */
  async active(userId: string, limit = 20): Promise<CommitmentRow[]> {
    return this.db
      .select()
      .from(commitments)
      .where(and(eq(commitments.userId, userId), eq(commitments.status, 'active')))
      .orderBy(commitments.nextExpectedOn, desc(commitments.lastReceivedOn), desc(commitments.id))
      .limit(Math.min(Math.max(limit, 1), 50));
  }

  async paused(userId: string, limit = 20): Promise<CommitmentRow[]> {
    return this.db
      .select()
      .from(commitments)
      .where(and(eq(commitments.userId, userId), eq(commitments.status, 'paused')))
      .orderBy(desc(commitments.lastReceivedOn), desc(commitments.id))
      .limit(Math.min(Math.max(limit, 1), 50));
  }

  /**
   * Commitments that still owe a message this cycle. Paused commitments never
   * appear. The SQL filter excludes dates already texted, so a large backlog
   * cannot starve newer rows behind its own processed heads.
   */
  async dueForFollowUp(today: string, lateCutoff: string, limit = 500): Promise<CommitmentRow[]> {
    return this.db
      .select()
      .from(commitments)
      .where(
        and(
          eq(commitments.status, 'active'),
          lte(commitments.nextExpectedOn, today),
          or(
            and(
              gt(commitments.nextExpectedOn, lateCutoff),
              or(
                isNull(commitments.lastExpectedFor),
                ne(commitments.lastExpectedFor, commitments.nextExpectedOn),
              ),
            ),
            and(
              lte(commitments.nextExpectedOn, lateCutoff),
              or(
                isNull(commitments.lastMissingFor),
                ne(commitments.lastMissingFor, commitments.nextExpectedOn),
              ),
            ),
          ),
        ),
      )
      .orderBy(asc(commitments.nextExpectedOn))
      .limit(Math.min(Math.max(limit, 1), 1000));
  }

  async addEvent(
    commitmentId: string,
    userId: string,
    kind: CommitmentEventKind,
    detail: Record<string, unknown> | null = null,
  ): Promise<void> {
    await this.db.insert(commitmentEvents).values({
      id: newId('cev'),
      commitmentId,
      userId,
      kind,
      detail,
    });
  }

  async events(commitmentId: string, limit = 20) {
    return this.db
      .select()
      .from(commitmentEvents)
      .where(eq(commitmentEvents.commitmentId, commitmentId))
      .orderBy(desc(commitmentEvents.createdAt))
      .limit(Math.min(Math.max(limit, 1), 100));
  }

  /**
   * Claim the one "expected" text for a cycle before sending it, so two ticks
   * or two engine replicas cannot both text the user. A failed send swallows
   * this cycle's nudge rather than risking a duplicate.
   */
  async claimExpected(id: string, expectedOn: string, at: Date): Promise<boolean> {
    const [row] = await this.db
      .update(commitments)
      .set({ lastExpectedFor: expectedOn, lastFollowUpAt: at, updatedAt: at })
      .where(
        and(
          eq(commitments.id, id),
          eq(commitments.status, 'active'),
          or(isNull(commitments.lastExpectedFor), ne(commitments.lastExpectedFor, expectedOn)),
        ),
      )
      .returning({ id: commitments.id });
    return Boolean(row);
  }

  /** Same one-shot claim for the later, quieter nudge. */
  async claimMissing(id: string, expectedOn: string, at: Date): Promise<boolean> {
    const [row] = await this.db
      .update(commitments)
      .set({
        lastMissingFor: expectedOn,
        lastExpectedFor: expectedOn,
        lastFollowUpAt: at,
        updatedAt: at,
      })
      .where(
        and(
          eq(commitments.id, id),
          eq(commitments.status, 'active'),
          or(isNull(commitments.lastMissingFor), ne(commitments.lastMissingFor, expectedOn)),
        ),
      )
      .returning({ id: commitments.id });
    return Boolean(row);
  }
}
