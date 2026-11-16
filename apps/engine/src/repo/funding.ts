import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { fundingQuotes } from '../db/schema.ts';
import { newId } from '../lib/ids.ts';

export type FundingRow = typeof fundingQuotes.$inferSelect;
export type FundingState = FundingRow['state'];

/** Rows still worth polling: open, or 1Click is processing the deposit. */
const LIVE = ['open', 'processing'] as const;

export class FundingRepo {
  constructor(private readonly db: Db) {}

  async create(row: Omit<FundingRow, 'id' | 'createdAt' | 'updatedAt'>): Promise<FundingRow> {
    const [r] = await this.db
      .insert(fundingQuotes)
      .values({ ...row, id: newId('fnd') })
      .returning();
    if (!r) throw new Error('funding insert failed');
    return r;
  }

  /** Oldest first, so a backlog cannot starve the row that is about to expire. */
  async live(limit = 50): Promise<FundingRow[]> {
    return this.db
      .select()
      .from(fundingQuotes)
      .where(inArray(fundingQuotes.state, [...LIVE]))
      .orderBy(asc(fundingQuotes.expiresAt))
      .limit(Math.min(Math.max(limit, 1), 200));
  }

  async get(id: string): Promise<FundingRow | null> {
    const [r] = await this.db.select().from(fundingQuotes).where(eq(fundingQuotes.id, id)).limit(1);
    return r ?? null;
  }

  /**
   * Move a row out of a live state exactly once, so two polls (or two engine
   * instances) cannot text the user about the same landing twice.
   */
  async claim(id: string, to: FundingState, patch: Partial<FundingRow> = {}): Promise<boolean> {
    const r = await this.db
      .update(fundingQuotes)
      .set({ ...patch, state: to, updatedAt: new Date() })
      .where(and(eq(fundingQuotes.id, id), inArray(fundingQuotes.state, [...LIVE])))
      .returning({ id: fundingQuotes.id });
    return r.length === 1;
  }

  /** Record a still-live state change (open -> processing) without claiming it. */
  async note(id: string, patch: Partial<FundingRow>): Promise<void> {
    await this.db
      .update(fundingQuotes)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(fundingQuotes.id, id));
  }
}
