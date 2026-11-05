import { and, eq, isNull, or } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { bots, messages, moods, soulsChangelog } from '../db/schema.ts';
import { newId } from '../lib/ids.ts';

export type BotRow = typeof bots.$inferSelect;
export type NewBotRow = typeof bots.$inferInsert;
export type BotStatus = BotRow['status'];
export type Mood = 'idle' | 'thinking' | 'win' | 'wink' | 'blocked' | 'paused' | 'done';

export class BotsRepo {
  constructor(private readonly db: Db) {}

  /** Built-ins (user_id null) + the user's own bots, active only. */
  async activeFor(userId: string): Promise<BotRow[]> {
    return this.db
      .select()
      .from(bots)
      .where(and(eq(bots.status, 'active'), or(isNull(bots.userId), eq(bots.userId, userId))))
      .orderBy(bots.builtIn, bots.slug);
  }

  async allSlugsFor(userId: string): Promise<Set<string>> {
    const rows = await this.db
      .select({ slug: bots.slug })
      .from(bots)
      .where(or(isNull(bots.userId), eq(bots.userId, userId)));
    return new Set(rows.map((r) => r.slug));
  }

  async byId(id: string): Promise<BotRow | null> {
    const [r] = await this.db.select().from(bots).where(eq(bots.id, id)).limit(1);
    return r ?? null;
  }

  async builtIn(slug: string): Promise<BotRow | null> {
    const [r] = await this.db
      .select()
      .from(bots)
      .where(and(isNull(bots.userId), eq(bots.slug, slug)))
      .limit(1);
    return r ?? null;
  }

  async insert(row: NewBotRow): Promise<BotRow> {
    const [r] = await this.db.insert(bots).values(row).returning();
    if (!r) throw new Error('bot insert failed');
    return r;
  }

  /** Upsert a built-in by slug (souls can be refreshed from disk on boot). */
  async upsertBuiltIn(
    row: Omit<NewBotRow, 'id' | 'userId' | 'builtIn' | 'status'>,
  ): Promise<BotRow> {
    const existing = await this.builtIn(row.slug);
    if (existing) {
      const [u] = await this.db
        .update(bots)
        .set({
          name: row.name,
          soulMd: row.soulMd,
          toolIds: row.toolIds,
          permissions: row.permissions,
        })
        .where(eq(bots.id, existing.id))
        .returning();
      return u ?? existing;
    }
    return this.insert({ ...row, id: newId('bot'), userId: null, builtIn: true, status: 'active' });
  }

  /** CAS status change. Returns null if the bot was not in `from`. */
  async setStatus(id: string, from: BotStatus, to: BotStatus): Promise<BotRow | null> {
    const [r] = await this.db
      .update(bots)
      .set({ status: to })
      .where(and(eq(bots.id, id), eq(bots.status, from)))
      .returning();
    return r ?? null;
  }

  async byOwnerSlug(userId: string, slug: string): Promise<BotRow | null> {
    const [r] = await this.db
      .select()
      .from(bots)
      .where(and(eq(bots.userId, userId), eq(bots.slug, slug)))
      .limit(1);
    return r ?? null;
  }

  async byApproval(approvalId: string): Promise<BotRow | null> {
    const [r] = await this.db.select().from(bots).where(eq(bots.approvalId, approvalId)).limit(1);
    return r ?? null;
  }

  async logSoulChange(botId: string, userId: string | null, diff: string, reason: string) {
    await this.db.insert(soulsChangelog).values({ id: newId('evt'), botId, userId, diff, reason });
  }
}

export class MoodsRepo {
  constructor(private readonly db: Db) {}

  async get(userId: string, botSlug = 'penny'): Promise<Mood> {
    const [r] = await this.db
      .select({ mood: moods.mood })
      .from(moods)
      .where(and(eq(moods.userId, userId), eq(moods.botSlug, botSlug)))
      .limit(1);
    return r?.mood ?? 'idle';
  }

  async set(userId: string, botSlug: string, mood: Mood, reason: string): Promise<void> {
    await this.db
      .insert(moods)
      .values({ userId, botSlug, mood, reason })
      .onConflictDoUpdate({
        target: [moods.userId, moods.botSlug],
        set: { mood, reason, updatedAt: new Date() },
      });
  }
}

export class MessagesRepo {
  constructor(private readonly db: Db) {}

  async add(m: {
    conversationId: string;
    direction: 'inbound' | 'outbound';
    text: string;
    botId?: string | null;
    externalId?: string | null;
  }): Promise<void> {
    await this.db.insert(messages).values({
      id: newId('msg'),
      conversationId: m.conversationId,
      direction: m.direction,
      text: m.text,
      botId: m.botId ?? null,
      externalId: m.externalId ?? null,
    });
  }
}
