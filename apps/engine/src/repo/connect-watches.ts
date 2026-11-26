import { and, eq, gt, lte } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { connectWatches } from '../db/schema.ts';

export type ConnectWatchRow = typeof connectWatches.$inferSelect;

export class ConnectWatchesRepo {
  constructor(private readonly db: Db) {}

  /** Start (or restart) waiting for a user to connect a toolkit. */
  async watch(userId: string, toolkit: string, expiresAt: Date, cardId?: string): Promise<void> {
    await this.db
      .insert(connectWatches)
      .values({ userId, toolkit, status: 'waiting', expiresAt, cardId: cardId ?? null })
      .onConflictDoUpdate({
        target: [connectWatches.userId, connectWatches.toolkit],
        set: { status: 'waiting', expiresAt, cardId: cardId ?? null },
      });
  }

  async waiting(now: Date, limit = 200): Promise<ConnectWatchRow[]> {
    return this.db
      .select()
      .from(connectWatches)
      .where(and(eq(connectWatches.status, 'waiting'), gt(connectWatches.expiresAt, now)))
      .limit(limit);
  }

  /** CAS waiting -> connected, so only one tick announces a connection. */
  async markConnected(userId: string, toolkit: string): Promise<boolean> {
    const r = await this.db
      .update(connectWatches)
      .set({ status: 'connected' })
      .where(
        and(
          eq(connectWatches.userId, userId),
          eq(connectWatches.toolkit, toolkit),
          eq(connectWatches.status, 'waiting'),
        ),
      )
      .returning({ userId: connectWatches.userId });
    return r.length === 1;
  }

  async expire(now: Date): Promise<void> {
    await this.db
      .update(connectWatches)
      .set({ status: 'expired' })
      .where(and(eq(connectWatches.status, 'waiting'), lte(connectWatches.expiresAt, now)));
  }
}
