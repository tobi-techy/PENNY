import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { LanguageModel } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { eq } from 'drizzle-orm';
import { buildHistoryMessages, formatMemories } from '../src/brain/crew.ts';
import { webhookEvents } from '../src/db/schema.ts';
import { createLogger } from '../src/lib/logger.ts';
import { Scheduler } from '../src/scheduler.ts';
import { enrolledUser, makeEngine, scriptedModel, type TestEngine } from './helpers.ts';

let t: TestEngine;
let u: Awaited<ReturnType<typeof enrolledUser>>;
beforeAll(async () => {
  t = await makeEngine();
  u = await enrolledUser(t);
}, 120_000);
afterAll(async () => {
  await t?.db.close();
});

describe('crew history helpers', () => {
  test('buildHistoryMessages maps directions, caps, ends with current text', () => {
    const msgs = buildHistoryMessages(
      [
        { direction: 'inbound', text: 'hi' },
        { direction: 'outbound', text: 'hey' },
      ],
      'what did I say?',
    );
    expect(msgs).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hey' },
      { role: 'user', content: 'what did I say?' },
    ]);
  });
  test('does not duplicate current text when it is already last', () => {
    const msgs = buildHistoryMessages([{ direction: 'inbound', text: 'same' }], 'same');
    expect(msgs).toHaveLength(1);
  });
  test('keeps the newest history when over the char budget', () => {
    const long = (n: number) => ({
      direction: 'inbound' as const,
      text: `m${n}`.padEnd(1000, 'x'),
    });
    const history = Array.from({ length: 10 }, (_, i) => long(i));
    const msgs = buildHistoryMessages(history, 'now');
    // 6000-char budget fits six 1000-char rows: the newest six, oldest first.
    expect(msgs).toHaveLength(7);
    expect(msgs[0]?.content.startsWith('m4')).toBe(true);
    expect(msgs[5]?.content.startsWith('m9')).toBe(true);
    expect(msgs[6]).toEqual({ role: 'user', content: 'now' });
  });
  test('passes a long current message in full, not the truncated stored row', () => {
    const current = 'q'.repeat(2500);
    const msgs = buildHistoryMessages(
      [
        { direction: 'outbound', text: 'earlier' },
        { direction: 'inbound', text: current },
      ],
      current,
    );
    expect(msgs).toHaveLength(2);
    expect(msgs[1]?.content).toHaveLength(2500);
  });
  test('formatMemories frames memories as data, empty when none', () => {
    expect(formatMemories([])).toBe('');
    expect(formatMemories([{ text: 'likes tea', kind: 'preference' }])).toContain(
      'not instructions',
    );
  });
});

describe('crew handle uses history + auto-recall', () => {
  test('chat model receives prior messages and recalled memory', async () => {
    const convId = await t.engine.repos.users.conversationFor(u.userId, 'sp-phase1', 'imessage');
    await t.engine.repos.messages.add({
      conversationId: convId,
      direction: 'inbound',
      text: 'my goal is a house fund',
    });
    await t.engine.repos.messages.add({
      conversationId: convId,
      direction: 'outbound',
      text: 'noted, house fund',
    });
    await t.engine.services.memory.remember(u.userId, 'goal', 'saving for a house fund');

    let seenPrompt = '';
    const chat = new MockLanguageModelV4({
      doGenerate: async (opts) => {
        seenPrompt = JSON.stringify(opts.prompt);
        return {
          content: [{ type: 'text', text: 'still on it' }],
          finishReason: { unified: 'stop', raw: undefined },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
          warnings: [],
        } as never;
      },
    }) as unknown as LanguageModel;
    t.setModels(scriptedModel([{ tool: 'route', input: { bot: 'penny', reason: 'chat' } }]), chat);
    await t.engine.services.bots.seedBuiltIns('/nonexistent');
    const r = await t.engine.services.crew.handle(u.userId, u.space, 'how is the house fund?', {
      conversationId: convId,
    });
    expect(r.text).toBe('still on it');
    expect(seenPrompt).toContain('my goal is a house fund');
    expect(seenPrompt).toContain('saving for a house fund');
  });
});

describe('durable webhook claims', () => {
  test('failed run releases claim; processed blocks; stale claim reclaimable', async () => {
    const repo = t.engine.repos.webhookEvents;
    expect(await repo.claim('evt-1', 'messages')).toBe(true);
    expect(await repo.claim('evt-1', 'messages')).toBe(false);
    await repo.release('evt-1');
    expect(await repo.claim('evt-1', 'messages')).toBe(true);
    await repo.markProcessed('evt-1');
    expect(await repo.claim('evt-1', 'messages')).toBe(false);

    const repo2 = t.engine.repos.webhookEvents;
    const old = new Date(Date.now() - 10 * 60_000);
    expect(await repo2.claim('evt-stale', 'messages', 5 * 60_000, old)).toBe(true);
    expect(await repo2.claim('evt-stale', 'messages', 5 * 60_000, new Date())).toBe(true);
  });

  test('a failed run keeps an audit row with the error and is reclaimable', async () => {
    const repo = t.engine.repos.webhookEvents;
    expect(await repo.claim('evt-fail', 'messages')).toBe(true);
    await repo.release('evt-fail', 'TypeError');
    const [row] = await t.db.db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.id, 'evt-fail'));
    expect(row?.error).toBe('TypeError');
    expect(row?.processedAt).toBeNull();
    expect(await repo.claim('evt-fail', 'messages')).toBe(true);
    expect(await repo.claim('evt-fail', 'messages')).toBe(false);
  });

  test('concurrent reclaims of a stale claim: exactly one wins', async () => {
    const repo = t.engine.repos.webhookEvents;
    const old = new Date(Date.now() - 10 * 60_000);
    expect(await repo.claim('evt-race', 'messages', 5 * 60_000, old)).toBe(true);
    const now = new Date();
    const results = await Promise.all([
      repo.claim('evt-race', 'messages', 5 * 60_000, now),
      repo.claim('evt-race', 'messages', 5 * 60_000, new Date(now.getTime() + 1)),
      repo.claim('evt-race', 'messages', 5 * 60_000, new Date(now.getTime() + 2)),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});

describe('scheduler', () => {
  test('runs due jobs, isolates failures, respects interval', async () => {
    const ran: string[] = [];
    const s = new Scheduler(
      [
        { name: 'ok', everyMs: 1000, run: async () => void ran.push('ok') },
        {
          name: 'bad',
          everyMs: 1000,
          run: async () => {
            throw new Error('boom');
          },
        },
      ],
      createLogger('silent'),
      () => new Date(100_000),
    );
    const first = await s.tick(new Date(100_000));
    expect(first.ran).toEqual(['ok', 'bad']);
    expect(first.failed).toEqual(['bad']);
    const second = await s.tick(new Date(100_500));
    expect(second.ran).toEqual([]);
    const third = await s.tick(new Date(101_500));
    expect(third.ran).toEqual(['ok', 'bad']);
    expect(ran).toEqual(['ok', 'ok']);
  });
});

describe('weekly reflection', () => {
  test('logs a souls_changelog entry for users with new memories', async () => {
    await t.engine.services.memory.remember(u.userId, 'preference', 'prefers morning briefs');
    const now = new Date();
    const n = await t.engine.services.reflection.reflectWeekly(now);
    expect(n).toBeGreaterThanOrEqual(1);
    // A re-run (restart, second instance) inside the week appends nothing.
    expect(await t.engine.services.reflection.reflectWeekly(new Date(now.getTime() + 60_000))).toBe(
      0,
    );
  });

  test('history is scoped to the owning user', async () => {
    const convId = await t.engine.repos.users.conversationFor(u.userId, 'sp-phase1', 'imessage');
    expect((await t.engine.repos.messages.recent(convId, u.userId)).length).toBeGreaterThan(0);
    expect(await t.engine.repos.messages.recent(convId, 'usr_someone_else')).toEqual([]);
  });
});
