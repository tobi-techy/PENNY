import { beforeEach, describe, expect, test } from 'bun:test';
import {
  addMonths,
  amountChange,
  cadenceWord,
  commitmentKey,
  detectCadence,
  nextExpectedOn,
  normalizePayee,
} from '../src/commitments/cadence.ts';
import {
  commitmentsText,
  expectedText,
  missingText,
  pausedText,
  receiptSuffix,
  repeatLine,
  resumedText,
} from '../src/commitments/copy.ts';
import { FakeConnector } from '../src/connectors/composio.ts';
import type { CommitmentRow } from '../src/repo/commitments.ts';
import { enrolledUser, makeEngine, scriptedModel, type TestEngine } from './helpers.ts';

class InboxConnector extends FakeConnector {
  inbox: Record<string, unknown>[] = [];
  override async executeRead(): Promise<unknown> {
    return { data: { messages: this.inbox } };
  }
}

const octDstv = {
  messageId: 'dstv-oct',
  subject: 'DStv bill: ₦18,400 due 14 Oct',
  sender: 'DStv <noreply@dstv.com>',
  messageTimestamp: '2026-10-08T09:00:00Z',
  snippet: 'Your DStv Compact bill of ₦18,400 is due 14 Oct.',
};

const novDstv = {
  messageId: 'dstv-nov',
  subject: 'DStv bill: ₦18,400 due 14 Nov',
  sender: 'DStv <noreply@dstv.com>',
  messageTimestamp: '2026-11-08T09:00:00Z',
  snippet: 'Your DStv Compact bill of ₦18,400 is due 14 Nov.',
};

const decDstvMore = {
  messageId: 'dstv-dec',
  subject: 'DStv bill: ₦21,400 due 14 Dec',
  sender: 'DStv <noreply@dstv.com>',
  messageTimestamp: '2026-12-08T09:00:00Z',
  snippet: 'Your DStv Compact bill of ₦21,400 is due 14 Dec.',
};

function row(over: Partial<CommitmentRow> = {}): CommitmentRow {
  return {
    id: 'cmt_1',
    userId: 'usr_1',
    key: 'biller:dstv',
    billerId: 'dstv',
    payeeName: 'DStv',
    currency: 'NGN',
    cadence: 'monthly',
    cadenceDays: 31,
    lastBillId: 'bil_1',
    lastAmount: '18400',
    lastDueOn: '2026-11-14',
    lastReceivedOn: '2026-11-08',
    nextExpectedOn: '2026-12-08',
    seenCount: 2,
    paidCount: 1,
    lastPaidAt: null,
    lastPaidAmount: '18400',
    lastReceiptTx: null,
    status: 'active',
    lastExpectedFor: null,
    lastMissingFor: null,
    lastFollowUpAt: null,
    createdAt: new Date('2026-10-08T09:00:00Z'),
    updatedAt: new Date('2026-11-08T09:00:00Z'),
    ...over,
  };
}

describe('commitment cadence', () => {
  test('recognises weekly, monthly and yearly rhythms; leaves odd gaps alone', () => {
    expect(detectCadence(7)).toBe('weekly');
    expect(detectCadence(30)).toBe('monthly');
    expect(detectCadence(31)).toBe('monthly');
    expect(detectCadence(365)).toBe('yearly');
    expect(detectCadence(1)).toBeNull();
    expect(detectCadence(60)).toBeNull(); // a missed month is not a rhythm to promise
  });

  test('calendar months clamp to the last day instead of drifting', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15');
    expect(addMonths('2026-02-28', 12)).toBe('2027-02-28');
    expect(nextExpectedOn('2026-11-08', 'monthly')).toBe('2026-12-08');
    expect(nextExpectedOn('2026-11-08', 'weekly')).toBe('2026-11-15');
    expect(nextExpectedOn('2026-11-08', 'yearly')).toBe('2027-11-08');
  });

  test('one obligation per biller, or per payee and currency when unknown', () => {
    expect(commitmentKey({ billerId: 'dstv', payeeName: 'DStv', currency: 'NGN' })).toBe(
      'biller:dstv',
    );
    expect(commitmentKey({ billerId: null, payeeName: '  Mama  Ngozi! ', currency: 'NGN' })).toBe(
      'payee:mama ngozi:NGN',
    );
    expect(normalizePayee('DStv  Bill')).toBe('dstv bill');
  });

  test('amount changes are bigint-clean and never compare different currencies', () => {
    expect(amountChange('18400', 'NGN', '18400', 'NGN')).toEqual({
      direction: 'same',
      delta: null,
    });
    expect(amountChange('18400', 'NGN', '21400', 'NGN')).toEqual({
      direction: 'up',
      delta: '3000',
    });
    expect(amountChange('21400', 'NGN', '18400', 'NGN')).toEqual({
      direction: 'down',
      delta: '3000',
    });
    expect(amountChange('12', 'USD', '18400', 'NGN')).toEqual({
      direction: 'unknown',
      delta: null,
    });
  });

  test('repeat line speaks in the rhythm the user already has', () => {
    expect(repeatLine('18400', 'NGN', '18400', 'NGN', 'monthly')).toBe('same as last month.');
    expect(repeatLine('18400', 'NGN', '21400', 'NGN', 'monthly')).toBe(
      "that's ₦3,000 more than last month.",
    );
    expect(repeatLine('18400', 'NGN', '15400', 'NGN', 'monthly')).toBe(
      "that's ₦3,000 less than last month.",
    );
    expect(repeatLine('18400', 'NGN', '18400', 'NGN', null)).toBe('same as last time.');
    expect(repeatLine(null, null, '18400', 'NGN', 'monthly')).toBe('');
    expect(cadenceWord('weekly')).toBe('last week');
    expect(cadenceWord('yearly')).toBe('last year');
    expect(cadenceWord(null)).toBe('last time');
  });
});

describe('commitment copy', () => {
  test('the receipt names the next expected bill', () => {
    expect(receiptSuffix('2026-12-08')).toBe('next one expected around tue 8 dec.');
    expect(receiptSuffix(null)).toBe('');
  });

  test('one expected message and one later nudge, both plain', () => {
    expect(expectedText('DStv', '2026-12-08')).toBe(
      "i expected your DStv bill around tue 8 dec. nothing in your inbox yet. if it's gone for good, say stop watching DStv.",
    );
    expect(missingText('DStv')).toBe("still no DStv bill. i'll leave it here in case it's late.");
  });

  test('pause and resume say exactly what changed', () => {
    expect(pausedText('DStv')).toContain('stop watching DStv');
    expect(resumedText('DStv')).toBe('ok, watching DStv again.');
  });

  test('watching list shows rhythm, next date and payment history', () => {
    const text = commitmentsText([row()], [row({ id: 'cmt_2', payeeName: 'IKEDC' })]);
    expect(text).toContain("i'm watching 1 bill:");
    expect(text).toContain('• DStv: ₦18,400 monthly, next around tue 8 dec. paid once.');
    expect(text).toContain('paused: IKEDC.');
    expect(text).toContain('say stop watching <name> to pause one.');
  });

  test('an empty watch list says how to start', () => {
    expect(commitmentsText([], [])).toContain("i'm not watching any bills yet");
  });

  test('a late obligation is shown as not seen, not as a future date', () => {
    const text = commitmentsText([row()], [], '2026-12-12');
    expect(text).toContain('expected tue 8 dec, not seen');
    expect(text).not.toContain('next around');
  });
});

describe('commitments (engine)', () => {
  let t: TestEngine;
  let inbox: InboxConnector;
  let u: Awaited<ReturnType<typeof enrolledUser>>;

  async function loadInbox(mails: Record<string, unknown>[] = []) {
    inbox.inbox = mails;
    return t.engine.services.bills.scanAll();
  }

  beforeEach(async () => {
    inbox = new InboxConnector();
    t = await makeEngine({
      connectors: inbox,
      extra: { explorerBaseUrl: 'https://testnet.nearblocks.io' },
    });
    t.clock.now = new Date('2026-10-08T12:00:00Z');
    u = await enrolledUser(t);
    await t.engine.repos.users.conversationFor(u.userId, u.space.spaceId, 'imessage', '+1555PENNY');
  });

  test('the first bill opens an obligation, and the next bill recognises it', async () => {
    await loadInbox([octDstv]);
    expect(t.messaging.texts.at(-1)?.text).toBe(
      "new bill: DStv: ₦18,400, due wed 14 oct. i'll remind you, and watch for the next one.",
    );
    expect(await t.engine.repos.commitments.active(u.userId)).toHaveLength(1);

    t.clock.now = new Date('2026-11-08T12:00:00Z');
    await loadInbox([octDstv, novDstv]);
    expect(t.messaging.texts.at(-1)?.text).toBe(
      "DStv again: ₦18,400, due sat 14 nov. same as last month. i'll remind you.",
    );

    const [watch] = await t.engine.repos.commitments.active(u.userId);
    expect(watch).toMatchObject({
      payeeName: 'DStv',
      cadence: 'monthly',
      cadenceDays: 31,
      seenCount: 2,
      nextExpectedOn: '2026-12-08',
      lastAmount: '18400',
    });
    expect(await t.engine.repos.commitments.events(watch?.id ?? '')).not.toHaveLength(0);
  });

  test('an interactive scan returns the obligation context for the reply', async () => {
    inbox.inbox = [octDstv];
    await t.engine.services.bills.scan(u.userId, { interactive: true });
    t.clock.now = new Date('2026-11-08T12:00:00Z');
    inbox.inbox = [octDstv, novDstv];
    const r = await t.engine.services.bills.scan(u.userId, { interactive: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.contexts[r.newBills[0]?.id ?? '']).toMatchObject({
      repeat: true,
      cadence: 'monthly',
      repeatLine: 'same as last month.',
    });
  });

  test('a rescan in the same cycle never texts the bill twice', async () => {
    await loadInbox([octDstv]);
    t.clock.now = new Date('2026-11-08T12:00:00Z');
    await loadInbox([octDstv, novDstv]);
    const before = t.messaging.texts.length;
    await loadInbox([octDstv, novDstv]);
    expect(t.messaging.texts.length).toBe(before);
    expect(t.messaging.texts.filter((x) => x.text.includes('DStv again'))).toHaveLength(1);
  });

  test('a price change is named in the bill text and recorded', async () => {
    await loadInbox([octDstv]);
    t.clock.now = new Date('2026-11-08T12:00:00Z');
    await loadInbox([octDstv, novDstv]);
    t.clock.now = new Date('2026-12-08T12:00:00Z');
    await loadInbox([octDstv, novDstv, decDstvMore]);
    expect(t.messaging.texts.at(-1)?.text).toContain(
      "DStv again: ₦21,400, due mon 14 dec. that's ₦3,000 more than last month.",
    );
    const [watch] = await t.engine.repos.commitments.active(u.userId);
    const events = await t.engine.repos.commitments.events(watch?.id ?? '');
    expect(events.some((e) => e.kind === 'amount_changed')).toBe(true);
  });

  test('a paid bill closes with a receipt that names the next expected one', async () => {
    await loadInbox([octDstv]);
    t.clock.now = new Date('2026-11-08T12:00:00Z');
    await loadInbox([octDstv, novDstv]);
    const nov = (await t.engine.services.bills.open(u.userId)).find(
      (b) => b.dueOn === '2026-11-14',
    );
    if (!nov) throw new Error('november bill missing');
    await t.engine.services.bills.markPaid(u.userId, nov.billId, {
      txHash: '5'.repeat(43),
      dryRun: false,
    });
    expect(t.messaging.texts.at(-1)?.text).toBe(
      "paid. DStv, ₦18,400. i've crossed it off and cancelled the reminder. next one expected around tue 8 dec.\nreceipt: https://testnet.nearblocks.io/txns/5555555555555555555555555555555555555555555",
    );
    const [watch] = await t.engine.repos.commitments.active(u.userId);
    expect(watch).toMatchObject({ paidCount: 1, lastPaidAmount: '18400' });
  });

  test('a dry run moves nothing and leaves the obligation untouched', async () => {
    await loadInbox([octDstv]);
    t.clock.now = new Date('2026-11-08T12:00:00Z');
    await loadInbox([octDstv, novDstv]);
    const nov = (await t.engine.services.bills.open(u.userId)).find(
      (b) => b.dueOn === '2026-11-14',
    );
    if (!nov) throw new Error('november bill missing');
    await t.engine.services.bills.markPaid(u.userId, nov.billId, { txHash: null, dryRun: true });
    expect(t.messaging.texts.at(-1)?.text).toContain('test run, nothing sent');
    const [watch] = await t.engine.repos.commitments.active(u.userId);
    expect(watch?.paidCount).toBe(0);
    expect(watch?.nextExpectedOn).toBe('2026-12-08');
  });

  test('one expected check, then one late nudge, never repeated', async () => {
    await loadInbox([octDstv]);
    t.clock.now = new Date('2026-11-08T12:00:00Z');
    await loadInbox([octDstv, novDstv]);

    t.clock.now = new Date('2026-12-08T08:05:00Z'); // 09:05 in Lagos
    expect(await t.engine.services.commitments.followUps()).toEqual({
      expected: 1,
      missing: 0,
    });
    expect(t.messaging.texts.at(-1)?.text).toBe(
      "i expected your DStv bill around tue 8 dec. nothing in your inbox yet. if it's gone for good, say stop watching DStv.",
    );
    expect(await t.engine.services.commitments.followUps()).toEqual({
      expected: 0,
      missing: 0,
    });
    // The processed cycle is out of the query entirely, not just a failed CAS.
    expect(
      await t.engine.repos.commitments.dueForFollowUp('2026-12-08', '2026-12-05'),
    ).toHaveLength(0);

    t.clock.now = new Date('2026-12-11T08:05:00Z'); // three days late
    expect(await t.engine.services.commitments.followUps()).toEqual({
      expected: 0,
      missing: 1,
    });
    expect(t.messaging.texts.at(-1)?.text).toBe(
      "still no DStv bill. i'll leave it here in case it's late.",
    );
    expect(await t.engine.services.commitments.followUps()).toEqual({
      expected: 0,
      missing: 0,
    });
    expect(
      await t.engine.repos.commitments.dueForFollowUp('2026-12-11', '2026-12-08'),
    ).toHaveLength(0);
  });

  test('the follow-up only fires in the 09:00 local hour', async () => {
    await loadInbox([octDstv]);
    t.clock.now = new Date('2026-11-08T12:00:00Z');
    await loadInbox([octDstv, novDstv]);
    t.clock.now = new Date('2026-12-08T12:00:00Z'); // 13:00 Lagos
    expect(await t.engine.services.commitments.followUps()).toEqual({
      expected: 0,
      missing: 0,
    });
  });

  test('dismissing the latest bill stops the watch instead of following up', async () => {
    await loadInbox([octDstv]);
    t.clock.now = new Date('2026-11-08T12:00:00Z');
    await loadInbox([octDstv, novDstv]);
    const nov = (await t.engine.services.bills.open(u.userId)).find(
      (b) => b.dueOn === '2026-11-14',
    );
    if (!nov) throw new Error('november bill missing');
    expect(await t.engine.services.bills.close(u.userId, nov.billId, 'dismissed')).toMatchObject({
      ok: true,
    });
    expect(await t.engine.repos.commitments.paused(u.userId)).toHaveLength(1);
    t.clock.now = new Date('2026-12-08T08:05:00Z');
    expect(await t.engine.services.commitments.followUps()).toEqual({
      expected: 0,
      missing: 0,
    });
  });

  test('pause stops every unprompted message and resume brings it back', async () => {
    await loadInbox([octDstv]);
    t.clock.now = new Date('2026-11-08T12:00:00Z');
    await loadInbox([octDstv, novDstv]);

    expect(await t.engine.services.commitments.pause(u.userId, 'dstv')).toMatchObject({
      ok: true,
    });
    expect(await t.engine.services.commitments.describe(u.userId)).toContain('paused: DStv.');
    t.clock.now = new Date('2026-12-08T08:05:00Z');
    expect(await t.engine.services.commitments.followUps()).toEqual({
      expected: 0,
      missing: 0,
    });

    expect(await t.engine.services.commitments.resume(u.userId, 'DStv')).toMatchObject({
      ok: true,
    });
    // The old expected date is in the past: resume gives it a day, not a text now.
    const [watch] = await t.engine.repos.commitments.active(u.userId);
    expect(watch?.nextExpectedOn).toBe('2026-12-09');
    t.clock.now = new Date('2026-12-09T08:05:00Z');
    expect(await t.engine.services.commitments.followUps()).toEqual({
      expected: 1,
      missing: 0,
    });
  });

  test('manage_commitments is a real tool the bots can call', async () => {
    await loadInbox([octDstv]);
    t.clock.now = new Date('2026-11-08T12:00:00Z');
    await loadInbox([octDstv, novDstv]);
    t.setModels(
      scriptedModel([{ tool: 'route', input: { bot: 'penny', reason: 'bills' } }]),
      scriptedModel([
        { tool: 'manage_commitments', input: { action: 'pause', name: 'DStv' } },
        { text: "ok, i'll stop watching DStv." },
      ]),
    );
    const r = await t.engine.services.crew.handle(u.userId, u.space, 'stop watching DStv');
    expect(r.toolCalls).toContain('manage_commitments');
    expect(await t.engine.repos.commitments.paused(u.userId)).toHaveLength(1);
  });
});
