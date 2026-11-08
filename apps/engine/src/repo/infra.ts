import { and, eq, gt, isNull, lt } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { attestChallenges, guardDecisions, idempotencyKeys, webhookEvents } from '../db/schema.ts';
import { newId } from '../lib/ids.ts';

/** Single-use App Attest challenges, bound to an enroll code hash. */
export class AttestChallengesRepo {
  constructor(private readonly db: Db) {}

  async create(
    codeHash: string,
    challengeB64: string,
    expiresAt: Date,
    purpose: 'app_attest' | 'passkey' = 'app_attest',
  ): Promise<string> {
    const id = newId('atch');
    await this.db
      .insert(attestChallenges)
      .values({ id, codeHash, challenge: challengeB64, expiresAt, purpose });
    return id;
  }

  /** Atomically consume a challenge for its purpose; returns its raw bytes or null. */
  async consume(
    id: string,
    codeHash: string,
    now: Date,
    purpose: 'app_attest' | 'passkey' = 'app_attest',
  ): Promise<Uint8Array | null> {
    const rows = await this.db
      .update(attestChallenges)
      .set({ usedAt: now })
      .where(
        and(
          eq(attestChallenges.id, id),
          eq(attestChallenges.codeHash, codeHash),
          eq(attestChallenges.purpose, purpose),
          isNull(attestChallenges.usedAt),
          gt(attestChallenges.expiresAt, now),
        ),
      )
      .returning({ challenge: attestChallenges.challenge });
    const row = rows[0];
    return row ? new Uint8Array(Buffer.from(row.challenge, 'base64url')) : null;
  }
}

export class WebhookEventsRepo {
  constructor(private readonly db: Db) {}

  /**
   * True if this delivery should be processed. A fresh insert claims it.
   * An existing row blocks while it is processed or claimed recently. A
   * claim whose run failed (error set) or went stale (crash) is reclaimable,
   * so a redelivery finishes the work instead of being dropped as a duplicate.
   * Reclaim is a compare-and-swap on the row we read, so two concurrent
   * redeliveries can never both win.
   */
  async claim(
    id: string,
    event: string,
    staleAfterMs = 5 * 60_000,
    now = new Date(),
  ): Promise<boolean> {
    const r = await this.db
      .insert(webhookEvents)
      .values({ id, event, receivedAt: now })
      .onConflictDoNothing()
      .returning({ id: webhookEvents.id });
    if (r.length === 1) return true;
    const [row] = await this.db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.id, id))
      .limit(1);
    if (!row || row.processedAt) return false;
    const failed = row.error !== null;
    if (!failed && now.getTime() - row.receivedAt.getTime() < staleAfterMs) return false;
    const reclaimed = await this.db
      .update(webhookEvents)
      .set({ receivedAt: now, error: null })
      .where(
        and(
          eq(webhookEvents.id, id),
          isNull(webhookEvents.processedAt),
          eq(webhookEvents.receivedAt, row.receivedAt),
          row.error === null ? isNull(webhookEvents.error) : eq(webhookEvents.error, row.error),
        ),
      )
      .returning({ id: webhookEvents.id });
    return reclaimed.length === 1;
  }

  /**
   * Record a failed run. The row stays (audit trail, with the error name) but
   * remains unprocessed, so a redelivery can reclaim and reprocess it.
   */
  async release(id: string, error = 'failed'): Promise<void> {
    await this.db
      .update(webhookEvents)
      .set({ error: error.slice(0, 200) })
      .where(and(eq(webhookEvents.id, id), isNull(webhookEvents.processedAt)));
  }

  async markProcessed(id: string, error?: string): Promise<void> {
    await this.db
      .update(webhookEvents)
      .set({ processedAt: new Date(), error: error ?? null })
      .where(and(eq(webhookEvents.id, id), isNull(webhookEvents.processedAt)));
  }

  /** Photon recommends a 24-48h dedupe TTL. */
  async prune(olderThan: Date): Promise<void> {
    await this.db.delete(webhookEvents).where(lt(webhookEvents.receivedAt, olderThan));
  }
}

export type IdemResult =
  | { kind: 'new' }
  | { kind: 'replay'; status: number; body: unknown }
  | { kind: 'conflict' } // same key, different request
  | { kind: 'in_flight' };

export class IdempotencyRepo {
  constructor(private readonly db: Db) {}

  async begin(scope: string, key: string, requestHash: string): Promise<IdemResult> {
    const inserted = await this.db
      .insert(idempotencyKeys)
      .values({ scope, key, requestHash })
      .onConflictDoNothing()
      .returning({ key: idempotencyKeys.key });
    if (inserted.length === 1) return { kind: 'new' };
    const [row] = await this.db
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key)))
      .limit(1);
    if (!row) return { kind: 'in_flight' };
    if (row.requestHash !== requestHash) return { kind: 'conflict' };
    if (row.responseStatus === null) return { kind: 'in_flight' };
    return { kind: 'replay', status: row.responseStatus, body: row.responseBody };
  }

  async finish(scope: string, key: string, status: number, body: unknown): Promise<void> {
    await this.db
      .update(idempotencyKeys)
      .set({ responseStatus: status, responseBody: body })
      .where(and(eq(idempotencyKeys.scope, scope), eq(idempotencyKeys.key, key)));
  }

  /** Drop old idempotency rows so the table does not grow forever. */
  async prune(olderThan: Date): Promise<void> {
    await this.db.delete(idempotencyKeys).where(lt(idempotencyKeys.createdAt, olderThan));
  }

  /** Let a failed attempt be retried with the same key. */
  async abandon(scope: string, key: string): Promise<void> {
    await this.db
      .delete(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.scope, scope),
          eq(idempotencyKeys.key, key),
          isNull(idempotencyKeys.responseStatus),
        ),
      );
  }
}

export class GuardDecisionsRepo {
  constructor(private readonly db: Db) {}

  async record(d: {
    userId: string;
    approvalId: string | null;
    plan: unknown;
    decision: 'allow_with_approval' | 'block' | 'needs_more_info';
    reasons: string[];
  }): Promise<void> {
    await this.db.insert(guardDecisions).values({ id: newId('gdc'), ...d });
  }
}
