import { and, desc, eq, gte, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { EMBEDDING_DIM, memories } from '../db/schema.ts';
import { newId } from '../lib/ids.ts';

/** Embedding provider behind an interface. */
export interface Embedder {
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

/** Pad (cosine-preserving) or reject vectors so they fit the column width. */
export function fitToColumn(v: number[], dim = EMBEDDING_DIM): number[] {
  if (v.length > dim) throw new Error(`embedding has ${v.length} dims, column holds ${dim}`);
  if (v.length === dim) return v;
  return [...v, ...new Array<number>(dim - v.length).fill(0)];
}

/** Deterministic hashing embedder for tests/dev. Not semantic beyond shared words. */
export class FakeEmbedder implements Embedder {
  readonly dimensions = 64;
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const v = new Array<number>(this.dimensions).fill(0);
      for (const w of t.toLowerCase().split(/\W+/).filter(Boolean)) {
        let h = 2166136261;
        for (let i = 0; i < w.length; i++) h = Math.imul(h ^ w.charCodeAt(i), 16777619);
        const idx = Math.abs(h) % this.dimensions;
        v[idx] = (v[idx] ?? 0) + 1;
      }
      const n = Math.hypot(...v) || 1;
      return v.map((x) => x / n);
    });
  }
}

export class MemoryService {
  constructor(
    private readonly db: Db,
    private readonly embedder: Embedder,
  ) {}

  async remember(userId: string, kind: string, text: string): Promise<string> {
    const clean = text.slice(0, 2000);
    const [vec] = await this.embedder.embed([clean]);
    const id = newId('mem');
    await this.db.insert(memories).values({
      id,
      userId,
      kind,
      text: clean,
      embedding: vec ? fitToColumn(vec) : null,
    });
    return id;
  }

  /** Recent memories for this user, newest first (dedupe + tests). */
  async recent(userId: string, k = 50): Promise<{ kind: string; text: string }[]> {
    return this.db
      .select({ kind: memories.kind, text: memories.text })
      .from(memories)
      .where(eq(memories.userId, userId))
      .orderBy(desc(memories.createdAt))
      .limit(Math.min(Math.max(k, 1), 200));
  }

  /** True when the same normalised fact is already stored for this user. */
  async hasText(userId: string, text: string): Promise<boolean> {
    const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
    const want = norm(text);
    return (await this.recent(userId, 100)).some((r) => norm(r.text) === want);
  }

  /** Memories learned since a date, newest first (weekly reflection). */
  async learnedSince(
    userId: string,
    since: Date,
    k = 10,
  ): Promise<{ text: string; kind: string; createdAt: Date }[]> {
    return this.db
      .select({ text: memories.text, kind: memories.kind, createdAt: memories.createdAt })
      .from(memories)
      .where(and(eq(memories.userId, userId), gte(memories.createdAt, since)))
      .orderBy(desc(memories.createdAt))
      .limit(Math.min(k, 50));
  }

  /** Nearest memories for this user only (privacy: always filtered by userId). */
  async recall(userId: string, query: string, k = 5): Promise<{ text: string; kind: string }[]> {
    const [vec] = await this.embedder.embed([query]);
    if (!vec) return [];
    const lit = `[${fitToColumn(vec).join(',')}]`;
    return this.db
      .select({ text: memories.text, kind: memories.kind })
      .from(memories)
      .where(and(eq(memories.userId, userId)))
      .orderBy(sql`${memories.embedding} <=> ${lit}::vector`, desc(memories.createdAt))
      .limit(Math.min(k, 20));
  }
}
