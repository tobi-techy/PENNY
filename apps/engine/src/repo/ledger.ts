import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client.ts';
import { ledgerEntries } from '../db/schema.ts';
import { newId } from '../lib/ids.ts';

export const DAY_MS = 24 * 60 * 60 * 1000;

export class LedgerRepo {
  constructor(private readonly db: Db) {}

  /** Rolling-window spend: reserved + settled, micro-USD. Optionally per bot. */
  async spentSince(userId: string, since: Date, botId?: string): Promise<bigint> {
    const conds = [
      eq(ledgerEntries.userId, userId),
      gte(ledgerEntries.createdAt, since),
      inArray(ledgerEntries.status, ['reserved', 'settled']),
    ];
    if (botId) conds.push(eq(ledgerEntries.botId, botId));
    const [r] = await this.db
      .select({ s: sql<string>`coalesce(sum(${ledgerEntries.amountMicrosUsd}), 0)::text` })
      .from(ledgerEntries)
      .where(and(...conds));
    return BigInt(r?.s ?? '0');
  }

  async knownRecipients(userId: string): Promise<Set<string>> {
    const rows = await this.db
      .selectDistinct({ r: ledgerEntries.recipient })
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.userId, userId), eq(ledgerEntries.status, 'settled')));
    return new Set(rows.map((x) => x.r).filter((x): x is string => x !== null));
  }

  async reserve(e: {
    userId: string;
    approvalId: string;
    botId: string | null;
    asset: string;
    amountMicrosUsd: bigint;
    recipient: string | null;
  }): Promise<void> {
    await this.db.insert(ledgerEntries).values({ id: newId('led'), status: 'reserved', ...e });
  }

  async setStatusForApproval(approvalId: string, status: 'settled' | 'released'): Promise<void> {
    await this.db
      .update(ledgerEntries)
      .set({ status })
      .where(and(eq(ledgerEntries.approvalId, approvalId), eq(ledgerEntries.status, 'reserved')));
  }
}
