import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { toMicros } from '@penny/shared';
import { and, eq } from 'drizzle-orm';
import { cards, ledgerEntries } from '../src/db/schema.ts';
import {
  buildCheckinCard,
  compareCopy,
  DAY_MS,
  shortRange,
  topRecipientCopy,
} from '../src/finance/summary.ts';
import { newId } from '../src/lib/ids.ts';
import { enrolledUser, makeEngine, type TestEngine } from './helpers.ts';

let t: TestEngine;
let u: Awaited<ReturnType<typeof enrolledUser>>;

beforeAll(async () => {
  t = await makeEngine();
  u = await enrolledUser(t);
  await t.engine.repos.users.conversationFor(u.userId, u.space.spaceId, 'imessage', '+15550100');
}, 120_000);

afterAll(async () => {
  await t?.db.close();
});

/** A settled (or reserved) ledger row, at a chosen time. */
async function spend(
  userId: string,
  usd: string,
  recipient: string,
  opts: { status?: 'settled' | 'reserved'; at?: Date } = {},
): Promise<void> {
  await t.db.db.insert(ledgerEntries).values({
    id: newId('led'),
    userId,
    approvalId: null,
    botId: null,
    asset: 'USDC',
    amountMicrosUsd: toMicros(usd),
    recipient,
    status: opts.status ?? 'settled',
    createdAt: opts.at ?? t.clock.now,
  });
}

async function checkinCards(userId: string) {
  return t.db.db
    .select()
    .from(cards)
    .where(and(eq(cards.userId, userId), eq(cards.type, 'checkin')));
}

describe('finance summary (pure)', () => {
  test('shortRange keeps one month when both ends share it', () => {
    expect(
      shortRange(new Date('2026-11-09T00:00:00Z'), new Date('2026-11-15T00:00:00Z'), 'UTC'),
    ).toBe('Nov 9 – 15');
    expect(
      shortRange(new Date('2026-10-31T00:00:00Z'), new Date('2026-11-06T00:00:00Z'), 'UTC'),
    ).toBe('Oct 31 – Nov 6');
  });

  test('compareCopy never judges, and handles the first week', () => {
    expect(compareCopy(1_000_000n, 0n)).toBe("first week I've got numbers for");
    expect(compareCopy(10_000_000n, 10_000_000n)).toBe('same as last week');
    expect(compareCopy(5_000_000n, 12_500_000n)).toBe('$7.50 less than last week');
    expect(compareCopy(12_500_000n, 5_000_000n)).toBe('$7.50 more than last week');
  });

  test('topRecipientCopy names a place and an amount, and caps long names', () => {
    expect(topRecipientCopy(null)).toBe('nothing yet');
    expect(topRecipientCopy({ recipient: 'amara.testnet', microsUsd: 10_000_000n })).toBe(
      'amara.testnet · $10.00',
    );
    expect(topRecipientCopy({ recipient: 'a'.repeat(80), microsUsd: 1_000_000n })).toContain('…');
  });

  test('buildCheckinCard: one number, one comparison, one place', () => {
    const c = buildCheckinCard({
      window: { totalMicrosUsd: 12_500_000n, count: 2 },
      prior: 0n,
      top: { recipient: 'amara.testnet', microsUsd: 10_000_000n },
      from: new Date('2026-11-09T00:00:00Z'),
      to: new Date('2026-11-15T00:00:00Z'),
      timeZone: 'UTC',
    });
    expect(c.amount).toBe('$12.50');
    expect(c.title).toContain('Nov 9 – 15');
    expect(c.lines[0]?.value).toBe('$12.50 in 2 payments');
    expect(c.lines[1]?.value).toBe("first week I've got numbers for");
    expect(c.lines[2]?.value).toBe('amara.testnet · $10.00');
  });

  test('one payment reads as "1 payment"', () => {
    const c = buildCheckinCard({
      window: { totalMicrosUsd: 5_000_000n, count: 1 },
      prior: 5_000_000n,
      top: null,
      from: new Date('2026-11-09T00:00:00Z'),
      to: new Date('2026-11-15T00:00:00Z'),
      timeZone: 'UTC',
    });
    expect(c.lines[0]?.value).toBe('$5.00 in 1 payment');
    expect(c.lines[2]?.value).toBe('nothing yet');
  });
});

describe('weekly check-in (engine)', () => {
  test('counts settled spend only, then never repeats the same week', async () => {
    await spend(u.userId, '10', 'amara.testnet');
    await spend(u.userId, '2.50', 'kemi.testnet');
    // A reservation still waits on Face ID: it is not money spent yet.
    await spend(u.userId, '50', 'big.testnet', { status: 'reserved' });
    // Last month does not belong in this week.
    await spend(u.userId, '99', 'old.testnet', {
      at: new Date(t.clock.now.getTime() - 30 * DAY_MS),
    });

    const sent = await t.engine.services.financeCheckin.run(t.clock.now);
    expect(sent).toBe(1);
    const rows = await checkinCards(u.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.agent).toBe('finance');
    expect(rows[0]?.amount).toBe('$12.50');
    expect(rows[0]?.lines[0]?.value).toBe('$12.50 in 2 payments');
    expect(rows[0]?.lines[2]?.value).toBe('amara.testnet · $10.00');

    // Same week, another tick: no second card.
    expect(await t.engine.services.financeCheckin.run(t.clock.now)).toBe(0);
    expect(await checkinCards(u.userId)).toHaveLength(1);
  });

  test('summary answers "what did I spend this week?" without the model', async () => {
    const s = await t.engine.services.financeCheckin.summary(u.userId, 7);
    expect(s.spent).toBe('$12.50');
    expect(s.payments).toBe(2);
    expect(s.mostTo).toBe('amara.testnet');
  });

  test('a quiet week sends nothing, and the next week sends again', async () => {
    // Eight days on, the last week's spend has left the window: nothing to report.
    t.clock.now = new Date(t.clock.now.getTime() + 8 * DAY_MS);
    expect(await t.engine.services.financeCheckin.run(t.clock.now)).toBe(0);
    expect(await checkinCards(u.userId)).toHaveLength(1);

    await spend(u.userId, '3', 'tolu.testnet');
    expect(await t.engine.services.financeCheckin.run(t.clock.now)).toBe(1);
    const rows = await checkinCards(u.userId);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.amount).sort()).toEqual(['$12.50', '$3.00']);
  });

  test('a demo user never gets a check-in', async () => {
    const demoUser = await t.engine.repos.users.findOrCreateByHandle('demo:checkin');
    await t.engine.repos.users.markDemo(demoUser.id);
    await t.engine.repos.users.conversationFor(demoUser.id, 'demo:checkin', 'imessage');
    await spend(demoUser.id, '7', 'amara.testnet');
    const before = await checkinCards(demoUser.id);
    expect(before).toHaveLength(0);
    await t.engine.services.financeCheckin.run(t.clock.now);
    expect(await checkinCards(demoUser.id)).toHaveLength(0);
  });
});
