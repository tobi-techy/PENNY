import { type MoneyPlan, toMicros } from '@penny/shared';
import type { ConnectorPort } from '../connectors/composio.ts';
import type { Logger } from '../lib/logger.ts';
import type { MessagingPort, SpaceRef } from '../ports/messaging.ts';
import type { ApprovalsRepo } from '../repo/approvals.ts';
import type { BillRow, BillsRepo } from '../repo/bills.ts';
import type { MessagesRepo } from '../repo/bots.ts';
import type { ReminderRow, RemindersRepo } from '../repo/cards.ts';
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
  /** Every notice goes through the one card sender (found bills are cards, not bullets). */
  cards?: import('../cards/sender.ts').CardSender;
  /** Biller registry in force (resolveBillers); defaults to the built-in list. */
  billers?: readonly Biller[];
  /** Explorer prefix for receipts, e.g. https://testnet.nearblocks.io/txns/ */
  explorerTxUrl?: string;
  log: Logger;
  timeZone: string;
  now: () => Date;
  /** Cancel live payment cards when a bill is closed (wired to the approval service). */
  onBillClosed?: (userId: string, billId: string) => Promise<void>;
};

export type ScanResult =
  | { ok: true; newBills: BillRow[]; reminded: string[]; open: BillRow[] }
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
    const reminded: string[] = [];
    for (const b of newBills) if (await this.scheduleBillReminder(b)) reminded.push(b.id);
    return { ok: true, newBills, reminded, open: await this.d.bills.open(userId) };
  }

  private async hasBillReminder(billId: string): Promise<boolean> {
    // One reminder per bill, so a scheduled row is the proof the promise holds.
    return (await this.d.reminders.scheduledForBill(billId)) !== null;
  }

  /**
   * Remind at 09:00 local the day before the due date. If that has already passed
   * (the email landed late), fall back to 09:00 on the due date, then to a few
   * minutes out when the bill arrives on its due date. Returns whether a reminder
   * actually exists, so the new-bill text never promises one that was not made.
   */
  private async scheduleBillReminder(b: BillRow): Promise<boolean> {
    if (!b.dueOn) return false;
    const now = this.d.now();
    const dayBefore = localTimeOn(this.d.timeZone, addDays(b.dueOn, -1), REMINDER_HOUR);
    const dueMorning = localTimeOn(this.d.timeZone, b.dueOn, REMINDER_HOUR);
    let at: Date;
    let when: 'tomorrow' | 'today';
    if (dayBefore.getTime() > now.getTime()) {
      at = dayBefore;
      when = 'tomorrow';
    } else if (dueMorning.getTime() > now.getTime()) {
      at = dueMorning;
      when = 'today';
    } else {
      // Due today and 09:00 has gone: a few minutes out, but never on the next day.
      const soon = new Date(now.getTime() + 5 * 60_000);
      if (this.today() !== b.dueOn || localDate(this.d.timeZone, soon) !== b.dueOn) return false;
      at = soon;
      when = 'today';
    }
    const target = await this.d.users.primarySpace(b.userId);
    if (!target) return false; // never texted Penny: nowhere to remind them
    const amount = b.amount ? ` (${formatMoney(b.amount, b.currency)})` : '';
    const created = await this.d.reminders.createForBill({
      userId: b.userId,
      billId: b.id,
      text: `heads up: your ${b.payeeName} bill${amount} is due ${when}.`,
      dueAt: at,
      space: target.space,
    });
    return created !== null || (await this.hasBillReminder(b.id));
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
          if (!r.ok) continue; // read failed: leave unnotified bills for the next scan
          if (r.newBills.length) users += 1;
          // Retry every bill whose text never went out. A bill is marked notified
          // only after a successful send, so a failed send is not lost.
          const pendingText = await this.d.bills.unnotified(userId);
          if (!pendingText.length) continue;
          const now = this.d.now();
          const today = this.today();
          const inserted = new Set(r.newBills.map((b) => b.id));
          const fresh = (b: BillRow) =>
            b.dueOn
              ? b.dueOn >= today
              : now.getTime() - (b.receivedAt ?? now).getTime() < FRESH_NO_DUE_MS;
          // Old bills found on a first scan are stored quietly, never texted.
          const quiet = pendingText.filter((b) => inserted.has(b.id) && !fresh(b));
          if (quiet.length)
            await this.d.bills.markNotified(
              quiet.map((b) => b.id),
              now,
            );
          const toText = pendingText.filter((b) => !quiet.some((q) => q.id === b.id));
          if (!toText.length) continue;
          const reminded = new Set(
            (await this.d.reminders.scheduled(userId))
              .map((rem) => rem.billId)
              .filter((id): id is string => Boolean(id)),
          );
          // A found bill is a card: the same anatomy as every other result. Only a
          // successful card counts as notified, so an outage retries on the next scan.
          const notice = newBillsText(toText, reminded);
          if (!(await this.notifyNewBills(userId, target.space, toText, reminded, notice)))
            continue;
          await this.d.bills.markNotified(
            toText.map((b) => b.id),
            now,
          );
          await this.d.messages.add({
            conversationId: target.conversationId,
            direction: 'outbound',
            text: notice,
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

  /**
   * New bills arrive as a `found` card (Mail's colour, no Face ID: reading mail and
   * naming a bill changes nothing outside Penny). The plain text stays in the thread
   * history and is the fallback when cards aren't wired (unit tests).
   */
  private async notifyNewBills(
    userId: string,
    space: SpaceRef,
    bills: BillRow[],
    reminded: ReadonlySet<string>,
    text: string,
  ): Promise<boolean> {
    try {
      if (this.d.cards) {
        const card = newBillsCard(bills, reminded);
        await this.d.cards.send({
          userId,
          space,
          agent: 'mail',
          kind: 'info',
          type: 'found',
          title: card.title,
          ...(card.amount ? { amount: card.amount } : {}),
          lines: card.lines,
          buttons: [],
          state: 'done',
        });
      } else {
        await this.d.messaging.sendText(space, text);
      }
    } catch (e) {
      this.d.log.warn({ err: (e as Error).name, userId }, 'bill card failed; will retry');
      return false;
    }
    return true;
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
    /** The user's spendable USDC (tUSD on testnet), when known. */
    wallet: { usdc?: string } = {},
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
    const usd = bill.amount as string;
    if (wallet.usdc !== undefined && toMicros(wallet.usdc) < toMicros(usd)) {
      return {
        ok: false,
        reason: `not enough dollars on your penny account: this needs ${formatMoney(usd, 'USD')} and you have ${formatMoney(wallet.usdc, 'USD')}.`,
      };
    }
    const plan: PayBillPlan = {
      kind: 'pay_bill',
      billId: bill.id,
      payee: pay.biller.payTo,
      amount: usd,
      asset: 'USDC',
    };
    const facts = [
      { label: 'Bill', value: pay.biller.name },
      { label: 'Amount', value: `${formatMoney(usd, bill.currency)} in USDC` },
      { label: 'Pays', value: pay.biller.payTo },
      ...(bill.dueOn ? [{ label: 'Due', value: formatDay(bill.dueOn) }] : []),
    ];
    return { ok: true, plan, facts };
  }

  /** Called when a bill payment settles on chain: mark it paid and text a receipt. */
  async markPaid(
    userId: string,
    billId: string,
    receipt: { txHash: string | null; dryRun: boolean } = { txHash: null, dryRun: true },
  ): Promise<void> {
    // A dry run moved no money: never close the bill, cancel its reminder or imply
    // that a payment happened. The bill and reminder stay exactly as they were.
    if (receipt.dryRun) {
      const b = await this.d.bills.get(userId, billId);
      if (!b) return;
      const target = await this.d.users.primarySpace(userId);
      if (!target) return;
      const text = `paid (test run, nothing sent). ${b.payeeName}, ${formatMoney(b.amount, b.currency)}. it's still on your list.`;
      await this.d.messaging.sendText(target.space, text);
      await this.d.messages.add({
        conversationId: target.conversationId,
        direction: 'outbound',
        text,
      });
      return;
    }
    const b = await this.d.bills.close(userId, billId, 'paid');
    if (!b) return;
    await this.d.reminders.undoForBill(b.id);
    await this.d.onBillClosed?.(userId, b.id);
    const target = await this.d.users.primarySpace(userId);
    if (!target) return;
    const link =
      receipt.txHash && this.d.explorerTxUrl
        ? `\nreceipt: ${this.d.explorerTxUrl}${receipt.txHash}`
        : '';
    const text = `paid. ${b.payeeName}, ${formatMoney(b.amount, b.currency)}. i've crossed it off and cancelled the reminder.${link}`;
    await this.d.messaging.sendText(target.space, text);
    await this.d.messages.add({
      conversationId: target.conversationId,
      direction: 'outbound',
      text,
    });
  }

  async close(userId: string, billId: string, to: 'paid' | 'dismissed') {
    const b = await this.d.bills.close(userId, billId, to);
    if (!b) return { ok: false as const, error: 'no open bill with that id' };
    await this.d.reminders.undoForBill(b.id);
    // A closed bill must not still have a card that can pay it.
    await this.d.onBillClosed?.(userId, b.id);
    return { ok: true as const, bill: billView(b, this.today(), this.billers) };
  }

  /**
   * Re-read a bill before a stale card is renewed or relayed. Closes the gap
   * where a card minted before the bill was paid/dismissed could still spend.
   */
  async recheckBill(
    userId: string,
    billId: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const bill = await this.d.bills.get(userId, billId);
    if (!bill) return { ok: false, reason: 'that bill is no longer here' };
    const pay = payability(bill, this.billers);
    return pay.payable ? { ok: true } : { ok: false, reason: pay.why };
  }

  async reminders(userId: string) {
    return (await this.d.reminders.scheduled(userId)).map((r) => reminderView(r, this.d.timeZone));
  }

  async cancelReminder(userId: string, id: string) {
    return (await this.d.reminders.undoForUser(userId, id))
      ? { ok: true as const }
      : { ok: false as const, error: 'no pending reminder with that id' };
  }

  /**
   * Scheduler: text every due reminder exactly once (user-set and bill due dates).
   * A bill reminder is dropped if the bill was paid or dismissed meanwhile.
   */
  async sendDue(at: Date = this.d.now()): Promise<number> {
    let sent = 0;
    for (const r of await this.d.reminders.due(at)) {
      if (r.billId) {
        const bill = await this.d.bills.get(r.userId, r.billId);
        if (bill && bill.status !== 'open') {
          await this.d.reminders.undoForBill(bill.id);
          continue;
        }
      }
      if (!(await this.d.reminders.markSent(r.id))) continue;
      const text = r.source === 'bill' ? r.text : `reminder: ${r.text}`;
      try {
        await this.d.messaging.sendText(r.space, text);
        const target = await this.d.users.primarySpace(r.userId);
        if (target)
          await this.d.messages.add({
            conversationId: target.conversationId,
            direction: 'outbound',
            text,
          });
        sent += 1;
      } catch (e) {
        const err = (e as Error).name || 'send_failed';
        const terminal = await this.d.reminders.markFailed(r.id, err);
        this.d.log.warn(
          { err, reminderId: r.id, terminal },
          terminal ? 'reminder send failed; giving up' : 'reminder send failed; will retry',
        );
      }
    }
    return sent;
  }
}

/** The `found` card for fresh bills. One bill gets the number; several are rows. */
export function newBillsCard(
  fresh: BillRow[],
  reminded: ReadonlySet<string> = new Set(),
): { title: string; amount?: string; lines: { label?: string; value: string }[] } {
  const one = fresh.length === 1 ? fresh[0] : undefined;
  if (one) {
    const amount = one.amount ? formatMoney(one.amount, one.currency) : undefined;
    return {
      title: `New bill · ${one.payeeName}`.slice(0, 80),
      ...(amount ? { amount } : {}),
      lines: [
        { label: 'Due', value: one.dueOn ? formatDay(one.dueOn) : 'no due date' },
        {
          label: 'Reminder',
          value: reminded.has(one.id) ? "the day before it's due" : 'none',
        },
      ],
    };
  }
  return {
    title: `${fresh.length} new bills`,
    lines: [
      ...fresh.slice(0, 3).map((b) => ({
        label: b.payeeName.slice(0, 40),
        value: `${formatMoney(b.amount, b.currency)}${
          b.dueOn ? `, due ${formatDay(b.dueOn)}` : ''
        }`.slice(0, 120),
      })),
      ...(fresh.length > 3 ? [{ value: `…and ${fresh.length - 3} more` }] : []),
    ],
  };
}

export function newBillsText(fresh: BillRow[], reminded: ReadonlySet<string> = new Set()): string {
  const line = (b: BillRow) =>
    `${b.payeeName}: ${formatMoney(b.amount, b.currency)}${b.dueOn ? `, due ${formatDay(b.dueOn)}` : ''}`;
  if (fresh.length === 1) {
    const b = fresh[0] as BillRow;
    // Promise only what actually exists: a late bill with no reminder gets no promise.
    const remind = b.dueOn && reminded.has(b.id) ? " i'll remind you." : '';
    return `new bill: ${line(b)}.${remind}`;
  }
  const shown = fresh.slice(0, 3).map((b) => `• ${line(b)}`);
  const more =
    fresh.length > 3 ? `\n…and ${fresh.length - 3} more. ask me "what bills do i have?"` : '';
  return `${fresh.length} new bills:\n${shown.join('\n')}${more}`;
}
