import { afterEach, describe, expect, test } from 'bun:test';
import { offerLoop } from '../src/brain/crew.ts';
import {
  adjustScore,
  cleanProactiveText,
  FOLLOWUP_COMMAND_REPLY,
  fallbackFollowUp,
  followupCommand,
  formatFollowUpContext,
  isQuietTime,
  isTimeZone,
  loopDueAt,
  modeForScore,
  parseLearnedLoops,
  parseLearnedZone,
  shouldSend,
} from '../src/brain/followup.ts';
import { signSpectrum } from '../src/photon/verify.ts';
import {
  enrolledUser,
  makeEngine,
  scriptedModel,
  type TestEngine,
  WEBHOOK_SECRET,
} from './helpers.ts';

const LAGOS = 'Africa/Lagos';

describe('follow-up mode and commands', () => {
  test('score maps to quiet, steady, eager', () => {
    expect(modeForScore(0)).toBe('quiet');
    expect(modeForScore(24)).toBe('quiet');
    expect(modeForScore(50)).toBe('steady');
    expect(modeForScore(80)).toBe('eager');
    expect(adjustScore(98, 8)).toBe(100);
    expect(adjustScore(2, -8)).toBe(0);
  });

  test('only explicit phrases are commands', () => {
    expect(followupCommand('be quiet')).toBe('quiet');
    expect(followupCommand('be quiet?')).toBe('quiet');
    expect(followupCommand('stop following up!')).toBe('quiet');
    expect(followupCommand('normal again')).toBe('steady');
    expect(followupCommand('be more proactive')).toBe('eager');
    expect(followupCommand('quiet')).toBeNull(); // too ambiguous
    expect(followupCommand('normal')).toBeNull();
    expect(followupCommand('what is quiet hours')).toBeNull();
    expect(FOLLOWUP_COMMAND_REPLY.quiet).toContain('stay quiet');
  });
});

describe('follow-up loops', () => {
  test('parses the learner loop lines and ignores malformed ones', () => {
    expect(
      parseLearnedLoops(
        [
          'preference | likes tea',
          'loop | tomorrow | book the dentist',
          'loop | in 2 days | goal | save for a bike',
          'loop | someday | nonsense',
          'nonsense',
        ].join('\n'),
      ),
    ).toEqual([{ when: 'tomorrow', kind: 'asked', text: 'book the dentist' }]);
  });

  test('the learner can name the user time zone, and only a real one', () => {
    expect(parseLearnedZone('preference | likes tea\nzone | America/New_York')).toBe(
      'America/New_York',
    );
    expect(parseLearnedZone('zone | Africa/Lagos')).toBe('Africa/Lagos');
    expect(parseLearnedZone('zone | Not/AZone')).toBeNull();
    expect(parseLearnedZone('zone | new york')).toBeNull();
    expect(isTimeZone('Europe/London')).toBe(true);
    expect(isTimeZone('Europe/Nowhere')).toBe(false);
  });

  test('due times land at 09:00 local', () => {
    const now = new Date('2026-11-05T19:00:00Z'); // 20:00 Lagos
    expect(loopDueAt('tomorrow', now, LAGOS).toISOString()).toBe('2026-11-06T08:00:00.000Z');
    expect(loopDueAt('in_2_days', now, LAGOS).toISOString()).toBe('2026-11-07T08:00:00.000Z');
    expect(loopDueAt('next_week', now, LAGOS).toISOString()).toBe('2026-11-12T08:00:00.000Z');
  });

  test('the offer fallback catches "want me to ...?" only', () => {
    expect(offerLoop('mail found it. want me to line up paying it?')).toEqual({
      when: 'tomorrow',
      kind: 'asked',
      text: 'line up paying it',
    });
    expect(offerLoop('guard says no.')).toBeNull();
    expect(offerLoop('what can i do?')).toBeNull();
  });

  test('a learned time zone drives the follow-up clock', async () => {
    const t = await makeEngine();
    try {
      const u = await enrolledUser(t);
      expect(await t.engine.services.proactive.setTimezone(u.userId, 'America/New_York')).toBe(
        true,
      );
      expect((await t.engine.repos.followup.settings(u.userId)).timezone).toBe('America/New_York');
      const loop = await t.engine.services.proactive.addLoop(u.userId, {
        when: 'tomorrow',
        kind: 'asked',
        text: 'book the dentist',
      });
      // 09:00 in New York (EST) is 14:00 UTC.
      expect(loop?.dueAt.toISOString()).toBe('2026-11-06T14:00:00.000Z');
      expect(await t.engine.services.proactive.setTimezone(u.userId, 'Not/AZone')).toBe(false);
    } finally {
      await t.db.close();
    }
  });

  test('a duplicate open loop is not added twice', async () => {
    const t = await makeEngine();
    try {
      const u = await enrolledUser(t);
      const dueAt = new Date('2026-11-06T08:00:00Z');
      const first = await t.engine.repos.followup.addLoop({
        userId: u.userId,
        kind: 'asked',
        summary: 'book the dentist',
        dueAt,
      });
      const second = await t.engine.repos.followup.addLoop({
        userId: u.userId,
        kind: 'asked',
        summary: 'Book the dentist.',
        dueAt,
      });
      expect(first).not.toBeNull();
      expect(second).toBeNull();
      expect(await t.engine.repos.followup.openFor(u.userId)).toHaveLength(1);
    } finally {
      await t.db.close();
    }
  });

  test('only one engine can claim a due loop; a failed send releases it', async () => {
    const t = await makeEngine();
    try {
      const u = await enrolledUser(t);
      const loop = await t.engine.repos.followup.addLoop({
        userId: u.userId,
        kind: 'asked',
        summary: 'book the dentist',
        dueAt: new Date('2026-11-06T08:00:00Z'),
      });
      const now = new Date('2026-11-06T09:00:00Z');
      expect(await t.engine.repos.followup.claim(loop?.id ?? '', now)).toBe(true);
      expect(await t.engine.repos.followup.claim(loop?.id ?? '', now)).toBe(false);
      await t.engine.repos.followup.release(loop?.id ?? '', now);
      expect(await t.engine.repos.followup.claim(loop?.id ?? '', now)).toBe(true);
    } finally {
      await t.db.close();
    }
  });
});

describe('follow-up gate', () => {
  const base = {
    now: new Date('2026-11-05T10:00:00Z'), // 11:00 Lagos
    timeZone: LAGOS,
    sentToday: 0,
    lastProactiveAt: null,
    lastUserAt: null,
  };

  test('quiet hours wrap midnight', () => {
    expect(isQuietTime(LAGOS, new Date('2026-11-05T19:00:00Z'))).toBe(true); // 20:00
    expect(isQuietTime(LAGOS, new Date('2026-11-05T10:00:00Z'))).toBe(false); // 11:00
    expect(isQuietTime(LAGOS, new Date('2026-11-05T03:00:00Z'))).toBe(true); // 04:00
    expect(isQuietTime(LAGOS, new Date('2026-11-05T08:00:00Z'))).toBe(false); // 09:00
  });

  test('doing nothing is always valid', () => {
    expect(shouldSend({ ...base, score: 10 })).toEqual({ ok: false, reason: 'quiet_mode' });
    expect(shouldSend({ ...base, score: 50, sentToday: 1 })).toEqual({
      ok: false,
      reason: 'daily_cap',
    });
    expect(shouldSend({ ...base, score: 80, sentToday: 2 })).toEqual({
      ok: false,
      reason: 'daily_cap',
    });
    expect(shouldSend({ ...base, score: 50, now: new Date('2026-11-05T19:00:00Z') })).toEqual({
      ok: false,
      reason: 'quiet_hours',
    });
    expect(
      shouldSend({ ...base, score: 50, lastUserAt: new Date('2026-11-05T08:00:00Z') }),
    ).toEqual({ ok: false, reason: 'recent_activity' });
    expect(
      shouldSend({ ...base, score: 50, lastProactiveAt: new Date('2026-11-05T08:00:00Z') }),
    ).toEqual({ ok: false, reason: 'recent_proactive' });
    expect(shouldSend({ ...base, score: 50 })).toEqual({ ok: true });
  });

  test('eager allows two a day; steady one', () => {
    expect(shouldSend({ ...base, score: 80, sentToday: 1 })).toEqual({ ok: true });
    expect(shouldSend({ ...base, score: 50, sentToday: 1 })).toEqual({
      ok: false,
      reason: 'daily_cap',
    });
  });
});

describe('follow-up copy', () => {
  test('proactive text is plain, short, link-free, or SKIP', () => {
    expect(cleanProactiveText('SKIP')).toBeNull();
    expect(cleanProactiveText('')).toBeNull();
    expect(cleanProactiveText('**hey** 🎉 still want me to book it? https://x.test/a')).toBe(
      'hey still want me to book it?',
    );
    expect(cleanProactiveText('a'.repeat(400))?.length).toBeLessThanOrEqual(240);
  });

  test('the fallback is cleaned like any other proactive text', () => {
    const text = cleanProactiveText(
      fallbackFollowUp(
        {
          id: 'loop_1',
          kind: 'asked',
          summary: 'reply to ada 🎉 at https://bad.test/x',
          dueAt: new Date('2026-11-06T08:00:00Z'),
        },
        50,
      ),
    );
    expect(text).toContain('reply to ada');
    expect(text).not.toContain('🎉');
    expect(text).not.toContain('https://');
  });

  test('the live prompt gets loops, ids, and autonomy as data', () => {
    const text = formatFollowUpContext({
      score: 50,
      loops: [
        {
          id: 'loop_1',
          kind: 'asked',
          summary: 'book the dentist',
          dueAt: new Date('2026-11-06T08:00:00Z'),
        },
      ],
      lastProactive: {
        text: 'still want me to?',
        sentAt: new Date('2026-11-05T08:00:00Z'),
        outcome: 'pending',
      },
      now: new Date('2026-11-05T10:00:00Z'),
      timeZone: LAGOS,
    });
    expect(text).toContain('[loop_1]');
    expect(text).toContain('book the dentist');
    expect(text).toContain('Autonomy: steady');
    expect(text).toContain('no reply yet');
  });
});

function event(msgId: string, text: string, from = '+15550100') {
  return JSON.stringify({
    event: 'messages',
    space: { id: `any;-;${from}`, platform: 'iMessage', type: 'dm', phone: 'shared' },
    message: {
      id: msgId,
      platform: 'iMessage',
      direction: 'inbound',
      timestamp: '2026-11-05T10:00:00.000Z',
      sender: { id: from, platform: 'iMessage' },
      content: { type: 'text', text },
    },
  });
}

function post(t: TestEngine, body: string) {
  const ts = String(Math.floor(Date.now() / 1000));
  return t.engine.app.request('/v1/photon/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-spectrum-event': 'messages',
      'x-spectrum-webhook-id': crypto.randomUUID(),
      'x-spectrum-timestamp': ts,
      'x-spectrum-signature': signSpectrum(WEBHOOK_SECRET, ts, body),
    },
    body,
  });
}

describe('follow-up in the engine', () => {
  let t: TestEngine;
  afterEach(async () => {
    await t?.db.close();
  });

  test('a due loop produces one daylight follow-up, then the daily cap holds', async () => {
    const chat = scriptedModel([{ text: 'hey, still want me to book the dentist? no rush.' }]);
    t = await makeEngine({
      router: scriptedModel([{ tool: 'route', input: { bot: 'penny', reason: 'chat' } }]),
      chat,
    });
    const u = await enrolledUser(t);
    await t.engine.repos.users.conversationFor(u.userId, u.space.spaceId, 'iMessage', null);
    const loop = await t.engine.repos.followup.addLoop({
      userId: u.userId,
      kind: 'asked',
      summary: 'book the dentist',
      dueAt: new Date('2026-11-05T09:00:00Z'),
    });
    t.clock.now = new Date('2026-11-05T10:00:00Z'); // 11:00 Lagos

    const first = await t.engine.services.proactive.tick(t.clock.now);
    expect(first.sent).toBe(1);
    expect(t.messaging.texts.map((x) => x.text)).toContain(
      'hey, still want me to book the dentist? no rush.',
    );
    const rows = await t.engine.repos.followup.openFor(u.userId);
    expect(rows.find((r) => r.id === loop?.id)?.nudgeCount).toBe(1);
    expect((await t.engine.repos.followup.lastSent(u.userId))?.outcome).toBe('pending');

    const second = await t.engine.services.proactive.tick(t.clock.now);
    expect(second.sent).toBe(0);
    expect(t.messaging.texts).toHaveLength(1);
  });

  test('a failed send backs off instead of retrying every minute', async () => {
    t = await makeEngine({ chat: scriptedModel([{ text: 'hey, still want me to book it?' }]) });
    const u = await enrolledUser(t);
    await t.engine.repos.users.conversationFor(u.userId, u.space.spaceId, 'iMessage', null);
    const loop = await t.engine.repos.followup.addLoop({
      userId: u.userId,
      kind: 'asked',
      summary: 'book the dentist',
      dueAt: new Date('2026-11-05T09:00:00Z'),
    });
    const now = new Date('2026-11-05T10:00:00Z');
    t.clock.now = now;
    const original = t.messaging.sendText.bind(t.messaging);
    t.messaging.sendText = async () => {
      throw new Error('messaging down');
    };
    expect((await t.engine.services.proactive.tick(now)).sent).toBe(0);
    const [held] = await t.engine.repos.followup.openFor(u.userId);
    expect(held?.id).toBe(loop?.id);
    expect(held?.nudgeCount).toBe(0);
    expect(held?.lastNudgedAt).toBeNull();
    expect(held?.dueAt.getTime()).toBe(now.getTime() + 15 * 60_000);

    // Before the backoff expires the loop is not due, so no model call.
    t.clock.now = new Date(now.getTime() + 14 * 60_000);
    expect((await t.engine.services.proactive.tick(t.clock.now)).sent).toBe(0);

    t.messaging.sendText = original;
    t.clock.now = new Date(now.getTime() + 16 * 60_000);
    expect((await t.engine.services.proactive.tick(t.clock.now)).sent).toBe(1);
  });

  test('quiet mode and quiet hours both hold the message back', async () => {
    t = await makeEngine({ chat: scriptedModel([{ text: 'should not send' }]) });
    const u = await enrolledUser(t);
    await t.engine.repos.users.conversationFor(u.userId, u.space.spaceId, 'iMessage', null);
    await t.engine.services.proactive.setMode(u.userId, 'quiet');
    await t.engine.repos.followup.addLoop({
      userId: u.userId,
      kind: 'asked',
      summary: 'book the dentist',
      dueAt: new Date('2026-11-05T09:00:00Z'),
    });
    t.clock.now = new Date('2026-11-05T10:00:00Z');
    expect((await t.engine.services.proactive.tick(t.clock.now)).sent).toBe(0);
    expect(t.messaging.texts).toHaveLength(0);

    await t.engine.services.proactive.setMode(u.userId, 'steady');
    t.clock.now = new Date('2026-11-05T20:00:00Z'); // 21:00 Lagos
    expect((await t.engine.services.proactive.tick(t.clock.now)).sent).toBe(0);
    expect(t.messaging.texts).toHaveLength(0);
  });

  test('a reply marks the nudge answered, nudges again later, and raises the score', async () => {
    t = await makeEngine({
      chat: scriptedModel([{ text: 'hey, still want me to book it? no rush.' }]),
    });
    const u = await enrolledUser(t);
    await t.engine.repos.users.conversationFor(u.userId, u.space.spaceId, 'iMessage', null);
    const loop = await t.engine.repos.followup.addLoop({
      userId: u.userId,
      kind: 'asked',
      summary: 'book the dentist',
      dueAt: new Date('2026-11-05T09:00:00Z'),
    });
    t.clock.now = new Date('2026-11-05T10:00:00Z');
    await t.engine.services.proactive.tick(t.clock.now);

    await t.engine.services.proactive.onInbound(u.userId);
    const sent = await t.engine.repos.followup.lastSent(u.userId);
    expect(sent?.outcome).toBe('replied');
    expect((await t.engine.repos.followup.settings(u.userId)).score).toBe(54);
    const [stillOpen] = await t.engine.repos.followup.openFor(u.userId);
    expect(stillOpen?.id).toBe(loop?.id);
    expect(stillOpen?.dueAt.getTime()).toBeGreaterThan(t.clock.now.getTime());
  });

  test('the learner creates one loop, and a second call does not duplicate it', async () => {
    t = await makeEngine({ extra: { autoLearn: true } });
    const u = await enrolledUser(t);
    t.setModels(
      scriptedModel([{ text: '' }]),
      scriptedModel([
        { text: 'fact | lives in Lagos\nloop | tomorrow | book the dentist' },
        { text: 'loop | tomorrow | book the dentist' },
      ]),
    );
    await t.engine.services.crew.learnFromTurn(
      u.userId,
      "i'll book the dentist tomorrow, i live in lagos",
      'ok, want me to remind you?',
    );
    let loops = await t.engine.repos.followup.openFor(u.userId);
    expect(loops).toHaveLength(1);
    expect(loops[0]?.summary).toBe('book the dentist');
    expect(loops[0]?.dueAt.toISOString()).toBe('2026-11-06T08:00:00.000Z');
    expect((await t.engine.services.memory.recent(u.userId)).map((m) => m.text)).toContain(
      'lives in Lagos',
    );

    t.clock.now = new Date(t.clock.now.getTime() + 30_000);
    await t.engine.services.crew.learnFromTurn(
      u.userId,
      'still need to book the dentist',
      'want me to book the dentist?',
    );
    loops = await t.engine.repos.followup.openFor(u.userId);
    expect(loops).toHaveLength(1);
  });

  test('the offer fallback records an unanswered "want me to" without the model', async () => {
    t = await makeEngine({ extra: { autoLearn: true } });
    const u = await enrolledUser(t);
    t.setModels(scriptedModel([{ text: '' }]), scriptedModel([{ text: 'NONE' }]));
    await t.engine.services.crew.learnFromTurn(
      u.userId,
      'there is a bill from nepa due friday',
      'mail found it. want me to line up paying it?',
    );
    const loops = await t.engine.repos.followup.openFor(u.userId);
    expect(loops.map((l) => l.summary)).toEqual(['line up paying it']);
  });

  test('"be quiet" is handled without calling the model', async () => {
    const router = scriptedModel([{ tool: 'route', input: { bot: 'penny', reason: 'chat' } }]);
    const chat = scriptedModel([{ text: 'should not run' }]);
    t = await makeEngine({ router, chat });
    const res = await post(t, event('followup-cmd-1', 'be quiet'));
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(t.messaging.texts.at(-1)?.text).toBe(FOLLOWUP_COMMAND_REPLY.quiet);
    expect(router.calls()).toBe(0);
    expect(chat.calls()).toBe(0);
  });
});
