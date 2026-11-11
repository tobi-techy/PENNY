import { addDays, localDate, localHour } from '../bills/time.ts';
import type { Logger } from '../lib/logger.ts';
import type { MessagingPort } from '../ports/messaging.ts';
import type { BillRow, BillsRepo } from '../repo/bills.ts';
import type { MessagesRepo } from '../repo/bots.ts';
import type { CommitmentRow, CommitmentsRepo } from '../repo/commitments.ts';
import type { UsersRepo } from '../repo/users.ts';
import {
  amountChange,
  commitmentKey,
  daysBetween,
  detectCadence,
  nextExpectedOn,
  normalizePayee,
} from './cadence.ts';
import {
  commitmentsText,
  expectedText,
  missingText,
  pausedText,
  receiptSuffix,
  repeatLine,
  resumedText,
} from './copy.ts';
import type { BillContext } from './types.ts';

export type FollowUpResult = { expected: number; missing: number };
export type CommitmentActionResult = { ok: true; text: string } | { ok: false; text: string };

export type CommitmentsDeps = {
  commitments: CommitmentsRepo;
  bills: BillsRepo;
  users: UsersRepo;
  messages: MessagesRepo;
  messaging: MessagingPort;
  log: Logger;
  timeZone: string;
  now: () => Date;
};

/** Local hour window for the one unprompted check. */
const FOLLOW_UP_HOUR = 9;
const LATE_AFTER_DAYS = 3;

/**
 * Commitments are the obligation behind a bill: DStv every month, not "an
 * email on the 8th". One row survives from first sight to the receipt and the
 * next cycle. This service only reads and texts; it never moves money.
 */
export class CommitmentsService {
  constructor(private readonly d: CommitmentsDeps) {}

  private today(): string {
    return localDate(this.d.timeZone, this.d.now());
  }

  private receivedOn(bill: BillRow): string {
    return bill.receivedAt ? localDate(this.d.timeZone, bill.receivedAt) : this.today();
  }

  /**
   * Called for every stored bill. The first sight opens the obligation; every
   * later bill teaches the rhythm and compares itself with the last one.
   */
  async recordBill(bill: BillRow): Promise<BillContext> {
    const key = commitmentKey(bill);
    const receivedOn = this.receivedOn(bill);
    const existing = await this.d.commitments.byKey(bill.userId, key);

    if (!existing) {
      const created = await this.d.commitments.create({
        userId: bill.userId,
        key,
        billerId: bill.billerId,
        payeeName: bill.payeeName,
        currency: bill.currency,
        cadence: null,
        cadenceDays: null,
        lastBillId: bill.id,
        lastAmount: bill.amount,
        lastDueOn: bill.dueOn,
        lastReceivedOn: receivedOn,
        nextExpectedOn: null,
        seenCount: 1,
        paidCount: 0,
        lastPaidAt: null,
        lastPaidAmount: null,
        lastReceiptTx: null,
        lastExpectedFor: null,
        lastMissingFor: null,
        lastFollowUpAt: null,
      });
      await this.d.bills.linkCommitment(bill.userId, bill.id, created.id);
      await this.d.commitments.addEvent(created.id, bill.userId, 'opened', {
        billId: bill.id,
        amount: bill.amount,
        dueOn: bill.dueOn,
      });
      return {
        commitmentId: created.id,
        repeat: false,
        cadence: null,
        previousAmount: null,
        previousCurrency: null,
        repeatLine: '',
      };
    }

    const compares = existing.lastReceivedOn !== null && receivedOn > existing.lastReceivedOn;
    const gapDays = compares
      ? daysBetween(existing.lastReceivedOn as string, receivedOn)
      : existing.cadenceDays;
    // A backfilled older bill links to the obligation but never rewinds it.
    if (!compares) {
      await this.d.bills.linkCommitment(bill.userId, bill.id, existing.id);
      await this.d.commitments.addEvent(existing.id, bill.userId, 'bill', {
        billId: bill.id,
        amount: bill.amount,
        backfilled: true,
      });
      return {
        commitmentId: existing.id,
        repeat: true,
        cadence: existing.cadence,
        previousAmount: existing.lastAmount,
        previousCurrency: existing.currency,
        repeatLine: '',
      };
    }

    const cadence = existing.cadence ?? (gapDays === null ? null : detectCadence(gapDays));
    const next = cadence ? nextExpectedOn(receivedOn, cadence) : null;
    const change = amountChange(existing.lastAmount, existing.currency, bill.amount, bill.currency);
    const line = repeatLine(
      existing.lastAmount,
      existing.currency,
      bill.amount,
      bill.currency,
      cadence,
    );

    await this.d.commitments.update(existing.id, {
      billerId: bill.billerId ?? existing.billerId,
      payeeName: bill.payeeName,
      currency: bill.currency ?? existing.currency,
      cadence,
      cadenceDays: gapDays,
      lastBillId: bill.id,
      lastAmount: bill.amount,
      lastDueOn: bill.dueOn,
      lastReceivedOn: receivedOn,
      nextExpectedOn: next,
      seenCount: existing.seenCount + 1,
      // A bill arrived for this cycle: the next check waits for the next cycle.
      lastExpectedFor: null,
      lastMissingFor: null,
    });
    await this.d.bills.linkCommitment(bill.userId, bill.id, existing.id);
    await this.d.commitments.addEvent(existing.id, bill.userId, 'bill', {
      billId: bill.id,
      amount: bill.amount,
      dueOn: bill.dueOn,
      gapDays,
      cadence,
    });
    if (change.direction !== 'same' && change.direction !== 'unknown') {
      await this.d.commitments.addEvent(existing.id, bill.userId, 'amount_changed', {
        from: existing.lastAmount,
        to: bill.amount,
        direction: change.direction,
        delta: change.delta,
      });
    }

    return {
      commitmentId: existing.id,
      repeat: true,
      cadence,
      previousAmount: existing.lastAmount,
      previousCurrency: existing.currency,
      repeatLine: line,
    };
  }

  /**
   * Called after a real payment closes the bill. Returns the sentence for the
   * receipt: the next one has a date, so the loop closes instead of going quiet.
   */
  async markPaid(
    bill: BillRow,
    receipt: { txHash: string | null },
  ): Promise<{ nextExpectedOn: string | null } | null> {
    if (!bill.commitmentId) return null;
    const row = await this.d.commitments.get(bill.userId, bill.commitmentId);
    if (!row) return null;
    const paidAt = this.d.now();
    const next =
      row.cadence && row.lastReceivedOn ? nextExpectedOn(row.lastReceivedOn, row.cadence) : null;
    await this.d.commitments.update(row.id, {
      paidCount: row.paidCount + 1,
      lastPaidAt: paidAt,
      lastPaidAmount: bill.amount ?? row.lastPaidAmount,
      lastReceiptTx: receipt.txHash ?? row.lastReceiptTx,
      nextExpectedOn: next ?? row.nextExpectedOn,
      lastExpectedFor: null,
      lastMissingFor: null,
    });
    await this.d.commitments.addEvent(row.id, bill.userId, 'paid', {
      billId: bill.id,
      amount: bill.amount,
      txHash: receipt.txHash,
    });
    return { nextExpectedOn: next ?? row.nextExpectedOn };
  }

  /** The receipt line for a just-paid bill, or '' when there is nothing to promise. */
  receiptLine(result: { nextExpectedOn: string | null } | null): string {
    if (!result) return '';
    return receiptSuffix(result.nextExpectedOn);
  }

  /**
   * One check per cycle, at 09:00 local. If the bill is already a few days
   * late, send only the quieter nudge, not both. Returns how many went out.
   */
  async followUps(now = this.d.now()): Promise<FollowUpResult> {
    const hour = localHour(this.d.timeZone, now);
    if (hour < FOLLOW_UP_HOUR || hour >= FOLLOW_UP_HOUR + 1) {
      return { expected: 0, missing: 0 };
    }
    const today = localDate(this.d.timeZone, now);
    const rows = await this.d.commitments.dueForFollowUp(today, addDays(today, -LATE_AFTER_DAYS));
    let expected = 0;
    let missing = 0;
    for (const row of rows) {
      const expectedOn = row.nextExpectedOn;
      if (!expectedOn) continue;
      const lateBy = daysBetween(expectedOn, today);
      const isLate = lateBy >= LATE_AFTER_DAYS;
      const claimed = isLate
        ? await this.d.commitments.claimMissing(row.id, expectedOn, now)
        : await this.d.commitments.claimExpected(row.id, expectedOn, now);
      if (!claimed) continue;
      const text = isLate ? missingText(row.payeeName) : expectedText(row.payeeName, expectedOn);
      try {
        if (!(await this.send(row.userId, text))) {
          this.d.log.info(
            { commitmentId: row.id, userId: row.userId },
            'commitment follow-up has no conversation; skipped',
          );
          continue;
        }
      } catch (e) {
        // The claim stays: a missed nudge is better than texting twice.
        this.d.log.warn(
          { err: (e as Error).name, commitmentId: row.id, userId: row.userId },
          'commitment follow-up failed',
        );
        continue;
      }
      await this.d.commitments.addEvent(row.id, row.userId, isLate ? 'missing' : 'expected', {
        expectedOn,
        lateBy,
      });
      if (isLate) missing += 1;
      else expected += 1;
    }
    return { expected, missing };
  }

  /** A dismissed bill that was the latest from its obligation stops the watch. */
  async dismiss(bill: BillRow): Promise<void> {
    if (!bill.commitmentId) return;
    const row = await this.d.commitments.get(bill.userId, bill.commitmentId);
    if (!row || row.status === 'paused' || row.lastBillId !== bill.id) return;
    await this.d.commitments.update(row.id, { status: 'paused' });
    await this.d.commitments.addEvent(row.id, bill.userId, 'paused', {
      reason: 'dismissed_bill',
      billId: bill.id,
    });
  }

  async describe(userId: string): Promise<string> {
    const active = await this.d.commitments.active(userId);
    const paused = await this.d.commitments.paused(userId);
    return commitmentsText(active, paused, this.today());
  }

  /** "stop watching DStv" — pauses every future unprompted message for it. */
  async pause(userId: string, query: string): Promise<CommitmentActionResult> {
    const match = await this.findOne(userId, query);
    if (!match.ok) return match;
    const row = match.row;
    if (row.status === 'paused')
      return { ok: true, text: `i'm already not watching ${row.payeeName}.` };
    await this.d.commitments.update(row.id, { status: 'paused' });
    await this.d.commitments.addEvent(row.id, userId, 'paused');
    return { ok: true, text: pausedText(row.payeeName) };
  }

  /** "start watching DStv" — resumes without firing a stale follow-up immediately. */
  async resume(userId: string, query: string): Promise<CommitmentActionResult> {
    const match = await this.findOne(userId, query);
    if (!match.ok) return match;
    const row = match.row;
    if (row.status === 'active')
      return { ok: true, text: `i'm already watching ${row.payeeName}.` };
    const today = this.today();
    const computed =
      row.cadence && row.lastReceivedOn ? nextExpectedOn(row.lastReceivedOn, row.cadence) : null;
    // If the next date already passed while paused, give it a day before checking.
    const next = computed && computed <= today ? addDays(today, 1) : computed;
    await this.d.commitments.update(row.id, {
      status: 'active',
      nextExpectedOn: next,
      lastExpectedFor: null,
      lastMissingFor: null,
    });
    await this.d.commitments.addEvent(row.id, userId, 'resumed');
    return { ok: true, text: resumedText(row.payeeName) };
  }

  private async findOne(
    userId: string,
    query: string,
  ): Promise<{ ok: true; row: CommitmentRow } | { ok: false; text: string }> {
    const norm = normalizePayee(query);
    const rows = [
      ...(await this.d.commitments.active(userId, 50)),
      ...(await this.d.commitments.paused(userId, 50)),
    ];
    const matches = rows.filter((r) => {
      const hay = normalizePayee(r.payeeName);
      return (
        (norm.length > 0 && hay.length > 0 && (hay.includes(norm) || norm.includes(hay))) ||
        r.billerId === query
      );
    });
    if (!matches.length) {
      return { ok: false, text: `i'm not watching anything called "${query}".` };
    }
    if (matches.length > 1) {
      return {
        ok: false,
        text: `which one? i'm watching ${matches.map((m) => m.payeeName).join(', ')}.`,
      };
    }
    return { ok: true, row: matches[0] as CommitmentRow };
  }

  private async send(userId: string, text: string): Promise<boolean> {
    const target = await this.d.users.primarySpace(userId);
    if (!target) return false;
    await this.d.messaging.sendText(target.space, text);
    await this.d.messages.add({
      conversationId: target.conversationId,
      direction: 'outbound',
      text,
    });
    return true;
  }
}
