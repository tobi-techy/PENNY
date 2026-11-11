import { and, asc, eq, lt, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { demoMessages, demoSessions } from '../db/schema.ts';

/** A demo thread lives for a day; the sweeper deletes it and the user it created. */
export const DEMO_TTL_MS = 24 * 60 * 60_000;

export type DemoSessionRow = {
  id: string;
  userId: string;
  conversationId: string | null;
  turns: number;
  expiresAt: Date;
};

export type DemoMessageRow = {
  seq: number;
  direction: 'inbound' | 'outbound';
  kind: 'text' | 'card' | 'typing';
  text: string | null;
  url: string | null;
  cardId: string | null;
};

/** The public demo thread: messages in, messages out, scoped to one capability token. */
export class DemoRepo {
  constructor(private readonly db: Db) {}

  /** `id` is the browser's capability (43 base64url chars), minted by the caller. */
  async create(
    id: string,
    userId: string,
    conversationId: string | null,
    now: Date,
  ): Promise<DemoSessionRow> {
    const [row] = await this.db
      .insert(demoSessions)
      .values({
        id,
        userId,
        conversationId,
        expiresAt: new Date(now.getTime() + DEMO_TTL_MS),
      })
      .returning();
    if (!row) throw new Error('demo session insert failed');
    return {
      id: row.id,
      userId: row.userId,
      conversationId: row.conversationId,
      turns: row.turns,
      expiresAt: row.expiresAt,
    };
  }

  async get(id: string, now: Date): Promise<DemoSessionRow | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(id)) return null;
    const [row] = await this.db.select().from(demoSessions).where(eq(demoSessions.id, id)).limit(1);
    if (!row || row.expiresAt.getTime() <= now.getTime()) return null;
    return {
      id: row.id,
      userId: row.userId,
      conversationId: row.conversationId,
      turns: row.turns,
      expiresAt: row.expiresAt,
    };
  }

  /** Count one model turn. Returns the new count, or null when the session is out of turns. */
  async spendTurn(id: string, max: number): Promise<number | null> {
    const [row] = await this.db
      .update(demoSessions)
      .set({ turns: sql`${demoSessions.turns} + 1` })
      .where(and(eq(demoSessions.id, id), lt(demoSessions.turns, max)))
      .returning({ turns: demoSessions.turns });
    return row?.turns ?? null;
  }

  async setConversation(id: string, conversationId: string): Promise<void> {
    await this.db.update(demoSessions).set({ conversationId }).where(eq(demoSessions.id, id));
  }

  async add(
    sessionId: string,
    m: {
      direction: 'inbound' | 'outbound';
      kind: 'text' | 'card' | 'typing';
      text?: string;
      url?: string;
      cardId?: string;
    },
  ): Promise<void> {
    await this.db.insert(demoMessages).values({
      sessionId,
      direction: m.direction,
      kind: m.kind,
      text: m.text ?? null,
      url: m.url ?? null,
      cardId: m.cardId ?? null,
    });
  }

  async thread(sessionId: string): Promise<DemoMessageRow[]> {
    const rows = await this.db
      .select()
      .from(demoMessages)
      .where(eq(demoMessages.sessionId, sessionId))
      .orderBy(asc(demoMessages.seq));
    return rows.map((r) => ({
      seq: r.seq,
      direction: r.direction,
      kind: r.kind,
      text: r.text,
      url: r.url,
      cardId: r.cardId,
    }));
  }

  /** A link card's token rotates when its state changes; keep the newest URL. */
  async updateCard(sessionId: string, cardId: string, url: string): Promise<void> {
    await this.db
      .update(demoMessages)
      .set({ url })
      .where(and(eq(demoMessages.sessionId, sessionId), eq(demoMessages.cardId, cardId)));
  }

  /**
   * Sweeper: drop expired sessions and everything they wrote. The user row stays:
   * it holds no money, no chain account and no trusted key, and other tables
   * (guard policy, device) reference it, so deleting it here would either leak a
   * foreign key or force this file to know every table that ever points at a user.
   * The growth that matters, the thread itself, cascades away with the session.
   */
  async prune(now: Date): Promise<number> {
    const dead = await this.db
      .select({ id: demoSessions.id })
      .from(demoSessions)
      .where(lt(demoSessions.expiresAt, now));
    for (const s of dead) await this.db.delete(demoSessions).where(eq(demoSessions.id, s.id));
    return dead.length;
  }
}
