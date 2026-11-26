import { and, asc, eq, getTableName, inArray, lt, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import {
  bills,
  bots,
  cards,
  commitmentEvents,
  commitments,
  connectWatches,
  conversations,
  demoMessages,
  demoSessions,
  devices,
  enrollCodes,
  followups,
  guardDecisions,
  guardPolicies,
  ledgerEntries,
  memories,
  messages,
  moods,
  openLoops,
  passkeys,
  proactiveMessages,
  reminders,
} from '../db/schema.ts';

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
   * Sweeper: drop expired sessions and the content the session wrote.
   *
   * The thread cascades with the session. Everything else a session created (cards,
   * ledger rows, guard decisions, the device, the conversation and its messages) is
   * removed here rather than accumulating one session at a time.
   *
   * Two things stay on purpose: the `users` row and its `approvals` with their
   * `approval_events`, which are append-only by trigger and are the audit trail of
   * every decision the demo made. A demo user holds no money, no chain account and no
   * usable key (the device is deleted), so what remains is a few audit rows per
   * session, not a thread a visitor can read.
   */
  async prune(now: Date): Promise<number> {
    const dead = await this.db
      .select({ id: demoSessions.id, userId: demoSessions.userId })
      .from(demoSessions)
      .where(lt(demoSessions.expiresAt, now));
    for (const s of dead) {
      // One transaction: the session row goes first, then its content. The audit rows
      // deliberately survive, so nothing here can leave a broken reference behind.
      await this.db.transaction(async (tx) => {
        await tx.delete(demoSessions).where(eq(demoSessions.id, s.id));
        await deleteFootprint(tx, s.userId);
      });
    }
    return dead.length;
  }
}

/**
 * Everything a demo session can write that is not the audit trail, children before the
 * rows they point at. Named from the schema itself rather than spelled by hand.
 */
const OWNED = [
  cards,
  ledgerEntries,
  guardDecisions,
  reminders,
  conversations,
  passkeys,
  devices,
  enrollCodes,
  guardPolicies,
  memories,
  moods,
  followups,
  openLoops,
  proactiveMessages,
  bills,
  commitmentEvents,
  commitments,
  connectWatches,
  bots,
];

/** The transaction handle, so the wipe below runs inside the sweeper's transaction. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Delete what one demo user left behind, except the append-only approval audit trail. */
async function deleteFootprint(db: Tx, userId: string): Promise<void> {
  // Messages inherit their owner through the conversation they point at.
  const conversationIds = (
    await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.userId, userId))
  ).map((r) => r.id);
  if (conversationIds.length > 0) {
    await db.delete(messages).where(inArray(messages.conversationId, conversationIds));
  }
  for (const t of OWNED) {
    await db.execute(sql`delete from ${sql.identifier(getTableName(t))} where user_id = ${userId}`);
  }
}
