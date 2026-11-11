import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { DEFAULT_INSTINCT_SCORE } from '../brain/instinct.ts';
import type { Db } from '../db/client.ts';
import { instincts, openLoops, proactiveMessages } from '../db/schema.ts';
import { newId } from '../lib/ids.ts';

export type InstinctRow = typeof instincts.$inferSelect;
export type LoopRow = typeof openLoops.$inferSelect;
export type ProactiveRow = typeof proactiveMessages.$inferSelect;

export type InstinctSettings = {
  score: number;
  quietStart: string;
  quietEnd: string;
  timezone: string | null;
};

export type AddLoopInput = {
  userId: string;
  kind: LoopRow['kind'];
  summary: string;
  dueAt: Date;
  source?: LoopRow['source'];
};

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?]+$/, '');

export class InstinctRepo {
  constructor(private readonly db: Db) {}

  /** Defaults for a user who has never tuned Penny. No row is written on read. */
  async settings(userId: string): Promise<InstinctSettings> {
    const [r] = await this.db
      .select({
        score: instincts.score,
        quietStart: instincts.quietStart,
        quietEnd: instincts.quietEnd,
        timezone: instincts.timezone,
      })
      .from(instincts)
      .where(eq(instincts.userId, userId))
      .limit(1);
    return (
      r ?? {
        score: DEFAULT_INSTINCT_SCORE,
        quietStart: '20:00',
        quietEnd: '08:00',
        timezone: null,
      }
    );
  }

  async setScore(userId: string, score: number, now = new Date()): Promise<void> {
    await this.db
      .insert(instincts)
      .values({ userId, score, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: instincts.userId, set: { score, updatedAt: now } });
  }

  async setQuietHours(
    userId: string,
    quietStart: string,
    quietEnd: string,
    now = new Date(),
  ): Promise<void> {
    await this.db
      .insert(instincts)
      .values({ userId, quietStart, quietEnd, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: instincts.userId,
        set: { quietStart, quietEnd, updatedAt: now },
      });
  }

  /** Add a loop unless the same thing is already open for this user. */
  async addLoop(input: AddLoopInput, now = new Date()): Promise<LoopRow | null> {
    const open = await this.openFor(input.userId, 50);
    if (open.some((l) => norm(l.summary) === norm(input.summary))) return null;
    const [r] = await this.db
      .insert(openLoops)
      .values({
        id: newId('loop'),
        userId: input.userId,
        kind: input.kind,
        summary: input.summary.slice(0, 500),
        source: input.source ?? 'turn',
        dueAt: input.dueAt,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return r ?? null;
  }

  async openFor(userId: string, limit = 20): Promise<LoopRow[]> {
    return this.db
      .select()
      .from(openLoops)
      .where(and(eq(openLoops.userId, userId), eq(openLoops.status, 'open')))
      .orderBy(asc(openLoops.dueAt), desc(openLoops.createdAt))
      .limit(Math.min(Math.max(limit, 1), 50));
  }

  /** Loops that are due now, oldest due first. The scheduler's only wake source. */
  async due(now: Date, limit = 50): Promise<LoopRow[]> {
    return this.db
      .select()
      .from(openLoops)
      .where(and(eq(openLoops.status, 'open'), lte(openLoops.dueAt, now)))
      .orderBy(asc(openLoops.dueAt), asc(openLoops.createdAt))
      .limit(Math.min(Math.max(limit, 1), 200));
  }

  /**
   * Claim a due loop for this tick before a model call or a send. A deploy can
   * briefly run two engines; the second must not text the same person twice.
   */
  async claim(id: string, now = new Date(), staleBefore?: Date): Promise<boolean> {
    const stale = staleBefore ?? new Date(now.getTime() - 5 * 60_000);
    const rows = await this.db
      .update(openLoops)
      .set({ lastNudgedAt: now, updatedAt: now })
      .where(
        and(
          eq(openLoops.id, id),
          eq(openLoops.status, 'open'),
          or(isNull(openLoops.lastNudgedAt), lte(openLoops.lastNudgedAt, stale)),
        ),
      )
      .returning({ id: openLoops.id });
    return rows.length === 1;
  }

  /** The send failed: let the next tick try this loop again. */
  async release(id: string, claimedAt: Date): Promise<void> {
    await this.db
      .update(openLoops)
      .set({ lastNudgedAt: null, updatedAt: claimedAt })
      .where(and(eq(openLoops.id, id), eq(openLoops.lastNudgedAt, claimedAt)));
  }

  /** Count a sent nudge; the second one drops the loop. */
  async markNudged(id: string, now = new Date()): Promise<boolean> {
    const rows = await this.db
      .update(openLoops)
      .set({
        nudgeCount: sql`${openLoops.nudgeCount} + 1`,
        status: sql`case when ${openLoops.nudgeCount} + 1 >= 2 then 'dropped' else 'open' end`,
        updatedAt: now,
      })
      .where(and(eq(openLoops.id, id), eq(openLoops.status, 'open')))
      .returning({ id: openLoops.id });
    return rows.length === 1;
  }

  /** Push a loop out after the user replied to a nudge about it. */
  async defer(userId: string, ids: string[], until: Date, now = new Date()): Promise<void> {
    if (!ids.length) return;
    await this.db
      .update(openLoops)
      .set({ dueAt: until, updatedAt: now })
      .where(
        and(eq(openLoops.userId, userId), inArray(openLoops.id, ids), eq(openLoops.status, 'open')),
      );
  }

  async close(
    userId: string,
    id: string,
    status: 'done' | 'dropped',
    now = new Date(),
  ): Promise<boolean> {
    const rows = await this.db
      .update(openLoops)
      .set({ status, updatedAt: now })
      .where(and(eq(openLoops.userId, userId), eq(openLoops.id, id), eq(openLoops.status, 'open')))
      .returning({ id: openLoops.id });
    return rows.length === 1;
  }

  /** Let go of loops nobody ever settled, so the list cannot grow without bound. */
  async dropStale(olderThan: Date, now = new Date()): Promise<number> {
    const rows = await this.db
      .update(openLoops)
      .set({ status: 'dropped', updatedAt: now })
      .where(and(eq(openLoops.status, 'open'), lte(openLoops.createdAt, olderThan)))
      .returning({ id: openLoops.id });
    return rows.length;
  }

  async countSentSince(userId: string, since: Date): Promise<number> {
    const [r] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(proactiveMessages)
      .where(and(eq(proactiveMessages.userId, userId), gte(proactiveMessages.sentAt, since)));
    return r?.n ?? 0;
  }

  async lastSent(userId: string): Promise<ProactiveRow | null> {
    const [r] = await this.db
      .select()
      .from(proactiveMessages)
      .where(eq(proactiveMessages.userId, userId))
      .orderBy(desc(proactiveMessages.sentAt), desc(proactiveMessages.id))
      .limit(1);
    return r ?? null;
  }

  /** The nudge the user may be replying to right now. */
  async pendingSince(userId: string, since: Date): Promise<ProactiveRow | null> {
    const [r] = await this.db
      .select()
      .from(proactiveMessages)
      .where(
        and(
          eq(proactiveMessages.userId, userId),
          eq(proactiveMessages.outcome, 'pending'),
          gte(proactiveMessages.sentAt, since),
        ),
      )
      .orderBy(desc(proactiveMessages.sentAt), desc(proactiveMessages.id))
      .limit(1);
    return r ?? null;
  }

  async log(input: {
    userId: string;
    text: string;
    loopIds: string[];
    sentAt: Date;
  }): Promise<ProactiveRow> {
    const [r] = await this.db
      .insert(proactiveMessages)
      .values({
        id: newId('pct'),
        userId: input.userId,
        text: input.text,
        loopIds: input.loopIds,
        sentAt: input.sentAt,
        createdAt: input.sentAt,
      })
      .returning();
    if (!r) throw new Error('proactive message insert failed');
    return r;
  }

  async markReplied(id: string, now = new Date()): Promise<void> {
    await this.db
      .update(proactiveMessages)
      .set({ outcome: 'replied', repliedAt: now, settledAt: now })
      .where(eq(proactiveMessages.id, id));
  }

  /** Mark long-unanswered nudges ignored. Returns the affected user ids. */
  async settleIgnored(olderThan: Date, now = new Date()): Promise<string[]> {
    const rows = await this.db
      .update(proactiveMessages)
      .set({ outcome: 'ignored', settledAt: now })
      .where(
        and(eq(proactiveMessages.outcome, 'pending'), lte(proactiveMessages.sentAt, olderThan)),
      )
      .returning({ userId: proactiveMessages.userId });
    return rows.map((r) => r.userId);
  }
}
