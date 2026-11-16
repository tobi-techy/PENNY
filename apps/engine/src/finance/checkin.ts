import { formatUsd } from '@penny/shared';
import type { CardSender } from '../cards/sender.ts';
import type { Logger } from '../lib/logger.ts';
import type { CardsRepo } from '../repo/cards.ts';
import type { LedgerRepo } from '../repo/ledger.ts';
import type { UsersRepo } from '../repo/users.ts';
import {
  buildCheckinCard,
  DAY_MS,
  type FinancePort,
  type SpendSummary,
  WEEK_MS,
} from './summary.ts';

const PAGE = 200;

export type FinanceCheckinDeps = {
  users: UsersRepo;
  ledger: LedgerRepo;
  cards: CardSender;
  cardsRepo: CardsRepo;
  log: Logger;
  now: () => Date;
  timeZone: string;
};

/**
 * Finance's weekly check-in: what actually settled in the last seven days, how
 * it compares, and where most of it went. One read-only card, Sunday-ish (the
 * job runs hourly; the per-user watermark makes it once a week).
 *
 * An empty week sends nothing: "$0.00 spent" every Sunday is noise, not help.
 * Reservations that are still waiting on Face ID are not counted (LedgerRepo).
 */
export class FinanceCheckinService implements FinancePort {
  constructor(private readonly d: FinanceCheckinDeps) {}

  async summary(userId: string, days: number): Promise<SpendSummary> {
    const to = this.d.now();
    const from = new Date(to.getTime() - days * DAY_MS);
    const [total, count, top] = await Promise.all([
      this.d.ledger.settledTotal(userId, from, to),
      this.d.ledger.settledCount(userId, from, to),
      this.d.ledger.topRecipient(userId, from, to),
    ]);
    return {
      days,
      spent: formatUsd(total),
      payments: count,
      mostTo: top?.recipient ?? null,
    };
  }

  /** Send this week's card to every user who has not had one in seven days. */
  async run(now = this.d.now()): Promise<number> {
    const from = new Date(now.getTime() - WEEK_MS);
    const priorFrom = new Date(now.getTime() - 2 * WEEK_MS);
    let sent = 0;
    let after: string | undefined;
    for (;;) {
      const ids = await this.d.users.listIds(PAGE, after);
      for (const userId of ids) {
        const user = await this.d.users.byId(userId);
        if (!user || user.isDemo) continue;
        const last = await this.d.cardsRepo.lastOfType(userId, 'checkin');
        if (last && last.getTime() > from.getTime()) continue;
        const total = await this.d.ledger.settledTotal(userId, from, now);
        if (total === 0n) continue;
        const space = await this.d.users.primarySpace(userId);
        if (!space) continue;
        const [prior, count, top] = await Promise.all([
          this.d.ledger.settledTotal(userId, priorFrom, from),
          this.d.ledger.settledCount(userId, from, now),
          this.d.ledger.topRecipient(userId, from, now),
        ]);
        const view = buildCheckinCard({
          window: { totalMicrosUsd: total, count },
          prior,
          top,
          from,
          to: now,
          timeZone: this.d.timeZone,
        });
        try {
          await this.d.cards.send({
            userId,
            space: space.space,
            agent: 'finance',
            kind: 'info',
            type: 'checkin',
            title: view.title,
            amount: view.amount,
            lines: view.lines,
            buttons: [],
            state: 'done',
          });
          sent += 1;
        } catch (e) {
          this.d.log.warn({ userId, err: (e as Error).name }, 'weekly check-in card failed');
        }
      }
      if (ids.length < PAGE) break;
      after = ids[ids.length - 1];
    }
    return sent;
  }
}
