import type { MoneyPlan } from '@penny/shared';
import type { ConnectorPort } from '../connectors/composio.ts';
import type { Logger } from '../lib/logger.ts';
import type { MessagingPort } from '../ports/messaging.ts';
import type { ApprovalsRepo } from '../repo/approvals.ts';
import type { BillRow, BillsRepo, ReminderRow, RemindersRepo } from '../repo/bills.ts';
import type { MessagesRepo } from '../repo/bots.ts';
import type { UsersRepo } from '../repo/users.ts';
import { BILLERS, type Biller, billerById } from './billers.ts';
import { formatDay, formatMoney, parseBills } from './parse.ts';

type PayBillPlan = Extract<MoneyPlan, { kind: 'pay_bill' }>;

import { addDays, localDate, localTimeOn } from './time.ts';

/** Gmail query: bill-ish subjects in the last 60 days, noise senders out. */
export function billSearchQuery(now: Date): string {
  const since = new Date(now.getTime() - 60 * 86_400_000);
  const ymd = `${since.getUTCFullYear()}/${String(since.getUTCMonth() + 1).padStart(2, '0')}/${String(since.getUTCDate()).padStart(2, '0')}`;
  return `newer:${ymd} subject:(bill OR invoice OR payment OR due OR statement OR renewal OR subscription OR expires OR expiring OR overdue OR reminder) -subject:(receipt) -from:notifications@github.com -from:newsletter -from:substack`;
}

/**
 * Can this bill be paid in USDC from the app? Only when the registry biller has a
 * verified NEAR payout account, the bill is in USD and the email showed an amount.
 * Naira bills wait for a naira payment rail.
 */
export function payability(
  b: BillRow,
  billers: readonly Biller[] = BILLERS,
): { payable: true; biller: Biller & { payTo: string } } | { payable: false; why: string } {
  const biller = billerById(b.billerId, billers);
  if (b.status !== 'open') return { payable: false, why: `this bill is already ${b.status}` };
  if (!biller) return { payable: false, why: "I don't know how to pay this biller yet" };
  if (!biller.payTo)
    return { payable: false, why: `${biller.name} can't take payment through Penny yet` };
  if (b.currency !== 'USD')
    return { payable: false, why: 'naira bills need a naira payment option, coming soon' };
  if (!b.amount) return { payable: false, why: "the email didn't show an amount" };
  return { payable: true, biller: biller as Biller & { payTo: string } };
}

/** What the model and the user see for a bill. */
export function billView(b: BillRow, today: string, billers: readonly Biller[] = BILLERS) {
  const biller = billerById(b.billerId, billers);
  const pay = payability(b, billers);
  return {
    billId: b.id,
    payee: b.payeeName,
    knownBiller: Boolean(biller),
    amount: formatMoney(b.amount, b.currency),
    dueOn: b.dueOn,
    due: b.dueOn ? formatDay(b.dueOn) : 'no due date in the email',
    overdue: b.dueOn ? b.dueOn < today : false,
    status: b.status,
    subject: b.subject,
    payableInApp: pay.payable,
    ...(pay.payable ? {} : { notPayableBecause: pay.why }),
  };
}

export function reminderView(r: ReminderRow, tz: string) {
  return {
    reminderId: r.id,
    text: r.text,
    at: new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(r.dueAt),
    atIso: r.dueAt.toISOString(),
    source: r.source,
  };
}

const MAX_PENDING_REMINDERS = 50;
const REMINDER_HOUR = 9; // local time, day before a bill is due
const FRESH_NO_DUE_MS = 3 * 86_400_000;

export type BillsDeps = {
  bills: BillsRepo;
  reminders: RemindersRepo;
  users: UsersRepo;
  messages: MessagesRepo;
  messaging: MessagingPort;
  connectors?: ConnectorPort;
  approvals?: ApprovalsRepo;
  /** Biller registry in force (resolveBillers); defaults to the built-in list. */
  billers?: readonly Biller[];
  log: Logger;
  timeZone: string;
  now: () => Date;
};

export type ScanResult =
  | { ok: true; newBills: BillRow[]; open: BillRow[] }
  | { ok: false; error: string };

/**
 * Bills and reminders. Everything here is deterministic: Gmail metadata is
 * parsed by code, reminders fire from the scheduler, and texts are templates.
 * Nothing here moves money; paying a bill is a separate Guard + approval step.
 */
export class BillsService {
  constructor(private readonly d: BillsDeps) {}

  get timeZone(): string {
    return this.d.timeZone;
  }

  private get billers(): readonly Biller[] {
    return this.d.billers ?? BILLERS;
  }

  today(): string {
    return localDate(this.d.timeZone, this.d.now());
  }

  /**
   * Read recent bill emails, store the new ones and schedule a reminder the day
   * before each future due date. `interactive` = the user asked, so the reply
   * itself tells them (new bills are stored as already notified).
   */
  async scan(userId: string, opts: { interactive: boolean }): Promise<ScanResult> {
    if (!this.d.connectors) return { ok: false, error: 'email not connected yet' };
    const now = this.d.now();
    let raw: unknown;
    try {
      raw = await this.d.connectors.executeRead(userId, 'mail', 'GMAIL_FETCH_EMAILS', {
        query: billSearchQuery(now),
        max_results: 15,
        verbose: false,
      });
    } catch (e) {
      return { ok: false, error: (e as Error).name || 'read_failed' };
    }
    const parsed = parseBills(raw, now, this.billers);
    const newBills = await this.d.bills.addNew(
      userId,
      parsed.map((p) => ({
        sourceKey: p.sourceKey,
        billerId: p.biller?.id ?? null,
        payeeName: p.payeeName,
        subject: p.subject,
        amount: p.amount,
        currency: p.currency,
        dueOn: p.dueOn,
        receivedAt: p.receivedAt,
      })),
      opts.interactive ? now : null,
    );
    for (const b of newBills) await this.scheduleBillReminder(b);
    return { ok: true, newBills, open: await this.d.bills.open(userId) };
  }

  /** Reminder at 09:00 local the day before the due date, if that is still ahead. */
  private async scheduleBillReminder(b: BillRow): Promise<void> {
    if (!b.dueOn) return;
    const at = localTimeOn(this.d.timeZone, addDays(b.dueOn, -1), REMINDER_HOUR);
    if (at.getTime() <= this.d.now().getTime()) return;
    const amount = b.amount ? ` (${formatMoney(b.amount, b.currency)})` : '';
    await this.d.reminders.add({
      userId: b.userId,
      text: `heads up: your ${b.payeeName} bill${amount} is due tomorrow.`,
      dueAt: at,
      source: 'bill',
      billId: b.id,
    });
  }

  /** Background: scan every user, text them about bills that are new and still relevant. */
  async scanAll(): Promise<{ users: number; notified: number }> {
    if (!this.d.connectors) return { users: 0, notified: 0 };
    let users = 0;
    let notified = 0;
    let after: string | undefined;
    for (;;) {
      const ids = await this.d.users.listIds(200, after);
      for (const userId of ids) {
        try {
          const target = await this.d.users.primarySpace(userId);
          if (!target) continue; // never texted Penny: nowhere to tell them
          const r = await this.scan(userId, { interactive: false });
          if (!r.ok || !r.newBills.length) continue;
          users += 1;
          const now = this.d.now();
          const today = this.today();
          const fresh = r.newBills.filter((b) =>
            b.dueOn
              ? b.dueOn >= today
              : now.getTime() - (b.receivedAt ?? now).getTime() < FRESH_NO_DUE_MS,
          );
          // Old bills found on a first scan are stored quietly, never texted.
          await this.d.bills.markNotified(
            r.newBills.map((b) => b.id),
            now,
          );
          if (!fresh.length) continue;
          const text = newBillsText(fresh);
          await this.d.messaging.sendText(target.space, text);
          await this.d.messages.add({
            conversationId: target.conversationId,
            direction: 'outbound',
            text,
          });
          notified += 1;
        } catch (e) {
          this.d.log.warn({ err: (e as Error).name, userId }, 'bill scan failed for user');
        }
      }
      if (ids.length < 200) break;
      after = ids[ids.length - 1];
    }
    return { users, notified };
  }

  async open(userId: string) {
    const today = this.today();
    return (await this.d.bills.open(userId)).map((b) => billView(b, today, this.billers));
  }

  /**
   * The only way a bill payment plan is made: from a stored bill and the biller
   * registry. Payee and amount never come from the model or the email body.
   */
  async paymentPlan(
    userId: string,
    billId: string,
  ): Promise<
    | { ok: true; plan: PayBillPlan; facts: { label: string; value: string }[] }
    | { ok: false; reason: string }
  > {
    const bill = await this.d.bills.get(userId, billId);
    if (!bill) return { ok: false, reason: 'no bill with that id' };
    const pay = payability(bill, this.billers);
    if (!pay.payable) return { ok: false, reason: pay.why };
    if (this.d.approvals) {
      const recent = await this.d.approvals.listForUser(userId, 50);
      const inFlight = recent.some(
        (a) =>
          a.kind === 'pay_bill' &&
          ['pending', 'signed', 'relayed'].includes(a.status) &&
          (a.plan as { billId?: string }).billId === bill.id,
      );
      if (inFlight) return { ok: false, reason: 'there is already a card out for this bill' };
    }
    const plan: PayBillPlan = {
      kind: 'pay_bill',
      billId: bill.id,
      payee: pay.biller.payTo,
      amount: bill.amount as string,
      asset: 'USDC',
    };
    const facts = [
      { label: 'Bill', value: pay.biller.name },
      { label: 'Amount', value: `${formatMoney(bill.amount, bill.currency)} in USDC` },
      { label: 'Pays', value: pay.biller.payTo },
      ...(bill.dueOn ? [{ label: 'Due', value: formatDay(bill.dueOn) }] : []),
    ];
    return { ok: true, plan, facts };
  }

  /** Called when a bill payment settles on chain. */
  async markPaid(userId: string, billId: string): Promise<void> {
    const b = await this.d.bills.close(userId, billId, 'paid');
    if (b) await this.d.reminders.cancelForBill(b.id);
  }

  async close(userId: string, billId: string, to: 'paid' | 'dismissed') {
    const b = await this.d.bills.close(userId, billId, to);
    if (!b) return { ok: false as const, error: 'no open bill with that id' };
    await this.d.reminders.cancelForBill(b.id);
    return { ok: true as const, bill: billView(b, this.today(), this.billers) };
  }

  async remind(userId: string, text: string, at: Date) {
    const now = this.d.now();
    if (Number.isNaN(at.getTime())) return { ok: false as const, error: 'bad time' };
    if (at.getTime() < now.getTime() + 30_000)
      return { ok: false as const, error: 'that time has already passed' };
    if (at.getTime() > now.getTime() + 366 * 86_400_000)
      return { ok: false as const, error: 'reminders can be at most a year ahead' };
    if ((await this.d.reminders.countPending(userId)) >= MAX_PENDING_REMINDERS)
      return { ok: false as const, error: 'too many reminders pending; cancel some first' };
    const r = await this.d.reminders.add({ userId, text, dueAt: at, source: 'user' });
    if (!r) return { ok: false as const, error: 'could not save reminder' };
    return { ok: true as const, reminder: reminderView(r, this.d.timeZone) };
  }

  async reminders(userId: string) {
    return (await this.d.reminders.pending(userId)).map((r) => reminderView(r, this.d.timeZone));
  }

  async cancelReminder(userId: string, id: string) {
    return (await this.d.reminders.cancel(userId, id))
      ? { ok: true as const }
      : { ok: false as const, error: 'no pending reminder with that id' };
  }

  /** Scheduler: text every due reminder once. */
  async sendDue(): Promise<number> {
    const now = this.d.now();
    let sent = 0;
    for (const r of await this.d.reminders.due(now)) {
      if (r.billId) {
        const bill = await this.d.bills.get(r.userId, r.billId);
        if (bill && bill.status !== 'open') {
          await this.d.reminders.cancelForBill(bill.id);
          continue;
        }
      }
      if (!(await this.d.reminders.claim(r.id, now))) continue;
      try {
        const target = await this.d.users.primarySpace(r.userId);
        if (!target) {
          await this.d.reminders.markFailed(r.id);
          continue;
        }
        const text = r.source === 'bill' ? r.text : `⏰ reminder: ${r.text}`;
        await this.d.messaging.sendText(target.space, text);
        await this.d.messages.add({
          conversationId: target.conversationId,
          direction: 'outbound',
          text,
        });
        sent += 1;
      } catch (e) {
        await this.d.reminders.markFailed(r.id);
        this.d.log.warn({ err: (e as Error).name, reminderId: r.id }, 'reminder send failed');
      }
    }
    return sent;
  }
}

export function newBillsText(fresh: BillRow[]): string {
  const line = (b: BillRow) =>
    `${b.payeeName}: ${formatMoney(b.amount, b.currency)}${b.dueOn ? `, due ${formatDay(b.dueOn)}` : ''}`;
  if (fresh.length === 1) {
    const b = fresh[0] as BillRow;
    const remind = b.dueOn ? " i'll remind you the day before." : '';
    return `mail here 📬 new bill in: ${line(b)}.${remind}`;
  }
  const shown = fresh.slice(0, 3).map((b) => `• ${line(b)}`);
  const more =
    fresh.length > 3 ? `\n…and ${fresh.length - 3} more. ask me "what bills do i have?"` : '';
  return `mail here 📬 ${fresh.length} new bills:\n${shown.join('\n')}${more}`;
}
