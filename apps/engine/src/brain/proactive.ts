import type { LanguageModel } from 'ai';
import { generateText } from 'ai';
import { describeNow } from '../bills/time.ts';
import type { Logger } from '../lib/logger.ts';
import type { MessagingPort } from '../ports/messaging.ts';
import type { MessagesRepo } from '../repo/bots.ts';
import type { FollowUpRepo, LoopRow } from '../repo/followup.ts';
import type { UsersRepo } from '../repo/users.ts';
import {
  adjustScore,
  cleanProactiveText,
  describeDue,
  type FollowUpMode,
  fallbackFollowUp,
  formatFollowUpContext,
  isTimeZone,
  type LearnedLoop,
  loopDueAt,
  modeForScore,
  PROACTIVE_SYSTEM,
  scoreForMode,
  shouldSend,
  startOfLocalDay,
} from './followup.ts';

const IGNORE_AFTER_MS = 48 * 60 * 60_000;
const REPLY_SCORE_DELTA = 4;
const IGNORE_SCORE_DELTA = -8;
const DEFER_AFTER_REPLY_MS = 3 * 24 * 60 * 60_000;
const STALE_LOOP_MS = 30 * 24 * 60 * 60_000;
const SEND_RETRY_MS = 15 * 60_000;

export type ProactiveDeps = {
  followup: FollowUpRepo;
  users: UsersRepo;
  messages: MessagesRepo;
  messaging: MessagingPort;
  model: LanguageModel;
  timeZone: string;
  now: () => Date;
  log: Logger;
};

/**
 * The always-on part of Penny. It wakes on due open loops (a DB query, no
 * tokens), checks a deterministic gate, and only then asks the model for one
 * sentence. The user can turn it down by replying or by saying "be quiet".
 */
export class ProactiveService {
  constructor(private readonly d: ProactiveDeps) {}

  /** Post-turn: save what the user left open, with the option to let it go. */
  async addLoop(userId: string, learned: LearnedLoop): Promise<LoopRow | null> {
    const now = this.d.now();
    const settings = await this.d.followup.settings(userId);
    const timeZone = settings.timezone ?? this.d.timeZone;
    return this.d.followup.addLoop(
      {
        userId,
        kind: learned.kind,
        summary: learned.text,
        dueAt: loopDueAt(learned.when, now, timeZone),
      },
      now,
    );
  }

  /** A text the live turn can see, so Penny remembers without being asked. */
  async contextFor(userId: string): Promise<string> {
    const now = this.d.now();
    try {
      const [settings, loops, last] = await Promise.all([
        this.d.followup.settings(userId),
        this.d.followup.openFor(userId, 5),
        this.d.followup.lastSent(userId),
      ]);
      return formatFollowUpContext({
        score: settings.score,
        loops: loops.map((l) => ({
          id: l.id,
          kind: l.kind,
          summary: l.summary,
          dueAt: l.dueAt,
        })),
        lastProactive: last
          ? { text: last.text, sentAt: last.sentAt, outcome: last.outcome }
          : null,
        now,
        timeZone: settings.timezone ?? this.d.timeZone,
      });
    } catch (e) {
      this.d.log.warn({ err: (e as Error).name }, 'follow-up context failed');
      return '';
    }
  }

  /** The user just texted: if they are answering a nudge, count it and back off. */
  async onInbound(userId: string): Promise<void> {
    const now = this.d.now();
    try {
      const pending = await this.d.followup.pendingSince(
        userId,
        new Date(now.getTime() - IGNORE_AFTER_MS),
      );
      if (!pending) return;
      await this.d.followup.markReplied(pending.id, now);
      const settings = await this.d.followup.settings(userId);
      await this.d.followup.setScore(userId, adjustScore(settings.score, REPLY_SCORE_DELTA), now);
      // They answered one thing; do not immediately ask about it again. If the
      // live turn settles it, close_open_loop marks it done instead.
      await this.d.followup.defer(
        userId,
        pending.loopIds,
        new Date(now.getTime() + DEFER_AFTER_REPLY_MS),
        now,
      );
    } catch (e) {
      this.d.log.warn({ err: (e as Error).name }, 'follow-up reply tracking failed');
    }
  }

  /** User command: quiet, steady or eager. */
  async setMode(userId: string, mode: FollowUpMode): Promise<void> {
    await this.d.followup.setScore(userId, scoreForMode(mode), this.d.now());
  }

  /** Remember the user's zone when they say where they are. */
  async setTimezone(userId: string, zone: string): Promise<boolean> {
    if (!isTimeZone(zone)) return false;
    await this.d.followup.setTimezone(userId, zone, this.d.now());
    return true;
  }

  /** The live turn settles an open thread, so no follow-up should repeat it. */
  async close(userId: string, id: string, status: 'done' | 'dropped'): Promise<boolean> {
    return this.d.followup.close(userId, id, status, this.d.now());
  }

  /** One scheduler tick. Ticks never overlap (Scheduler guards this). */
  async tick(at?: Date): Promise<{ sent: number; skipped: number }> {
    const now = at ?? this.d.now();
    try {
      await this.settleIgnored(now);
      await this.d.followup.dropStale(new Date(now.getTime() - STALE_LOOP_MS), now);
      const byUser = new Map<string, LoopRow[]>();
      for (const loop of await this.d.followup.due(now, 100)) {
        const list = byUser.get(loop.userId) ?? [];
        list.push(loop);
        byUser.set(loop.userId, list);
      }
      let sent = 0;
      let skipped = 0;
      for (const [userId, loops] of byUser) {
        const did = await this.tickUser(userId, loops, now);
        if (did) sent += 1;
        else skipped += 1;
      }
      return { sent, skipped };
    } catch (e) {
      this.d.log.error({ err: (e as Error).name }, 'follow-up tick failed');
      return { sent: 0, skipped: 0 };
    }
  }

  private async settleIgnored(now: Date): Promise<void> {
    const users = await this.d.followup.settleIgnored(
      new Date(now.getTime() - IGNORE_AFTER_MS),
      now,
    );
    for (const userId of new Set(users)) {
      const settings = await this.d.followup.settings(userId);
      await this.d.followup.setScore(userId, adjustScore(settings.score, IGNORE_SCORE_DELTA), now);
    }
  }

  private async tickUser(userId: string, loops: LoopRow[], now: Date): Promise<boolean> {
    const settings = await this.d.followup.settings(userId);
    const timeZone = settings.timezone ?? this.d.timeZone;
    const space = await this.d.users.primarySpace(userId);
    if (!space) return false;
    const [sentToday, lastProactive, lastUserAt] = await Promise.all([
      this.d.followup.countSentSince(userId, startOfLocalDay(timeZone, now)),
      this.d.followup.lastSent(userId),
      this.d.messages.lastAt(userId),
    ]);
    const gate = shouldSend({
      score: settings.score,
      now,
      timeZone,
      quietStart: settings.quietStart,
      quietEnd: settings.quietEnd,
      sentToday,
      lastProactiveAt: lastProactive?.sentAt ?? null,
      lastUserAt,
    });
    if (!gate.ok) {
      this.d.log.debug({ userId, reason: gate.reason }, 'follow-up held back');
      return false;
    }

    const chosen = loops[0];
    if (!chosen) return false;
    // Claim before composing: two engines must not text the same person twice.
    if (!(await this.d.followup.claim(chosen.id, now))) {
      this.d.log.debug({ userId, loopId: chosen.id }, 'follow-up loop already claimed');
      return false;
    }
    const text = await this.compose({
      userId,
      chosen,
      loops,
      score: settings.score,
      timeZone,
      now,
      conversationId: space.conversationId,
    });
    if (!text) {
      // The model read the thread and decided silence was better. Let it go.
      await this.d.followup.close(userId, chosen.id, 'dropped', now);
      return false;
    }
    try {
      await this.d.messaging.sendText(space.space, text);
    } catch (e) {
      this.d.log.warn({ err: (e as Error).name, userId }, 'proactive text failed; backing off');
      // Do not let a dead messaging port trigger a model call every minute.
      // Push the loop out and release it; the next tick after the backoff
      // can claim it again.
      try {
        await this.d.followup.defer(
          userId,
          [chosen.id],
          new Date(now.getTime() + SEND_RETRY_MS),
          now,
        );
        await this.d.followup.release(chosen.id, now);
      } catch (backoffError) {
        this.d.log.warn(
          { err: (backoffError as Error).name, userId, loopId: chosen.id },
          'proactive backoff write failed',
        );
      }
      return false;
    }
    try {
      await this.d.messages.add({
        conversationId: space.conversationId,
        direction: 'outbound',
        text,
      });
    } catch (e) {
      // The text is already out; never resend it only because history failed.
      this.d.log.warn({ err: (e as Error).name, userId }, 'proactive history write failed');
    }
    await this.d.followup.markNudged(chosen.id, now);
    await this.d.followup.log({ userId, text, loopIds: [chosen.id], sentAt: now });
    this.d.log.info(
      { userId, loopId: chosen.id, due: chosen.dueAt.toISOString() },
      'follow-up sent',
    );
    return true;
  }

  private async compose(input: {
    userId: string;
    chosen: LoopRow;
    loops: LoopRow[];
    score: number;
    timeZone: string;
    now: Date;
    conversationId: string;
  }): Promise<string | null> {
    let history: { direction: 'inbound' | 'outbound'; text: string; createdAt: Date }[] = [];
    try {
      history = await this.d.messages.recent(input.conversationId, input.userId, 6);
    } catch {
      /* no history is fine */
    }
    const recent = history
      .map((m) => `${m.direction === 'inbound' ? 'user' : 'penny'}: ${m.text.slice(0, 200)}`)
      .join('\n');
    const others = input.loops
      .filter((l) => l.id !== input.chosen.id)
      .slice(0, 4)
      .map((l) => `- (${describeDue(l.dueAt, input.now, input.timeZone)}) ${l.summary}`)
      .join('\n');
    const prompt = [
      `Now: ${describeNow(input.timeZone, input.now)}`,
      `Autonomy: ${modeForScore(input.score)}.`,
      `Follow up on: [${input.chosen.id}] (${input.chosen.kind}, ${describeDue(input.chosen.dueAt, input.now, input.timeZone)}) ${input.chosen.summary}`,
      others ? `Other open things (do not mention them):\n${others}` : '',
      recent ? `Recent thread:\n${recent}` : 'No recent thread.',
      'End with the one text, nothing else. If the thread shows they already did it, answer SKIP.',
    ]
      .filter(Boolean)
      .join('\n\n');
    try {
      const r = await generateText({
        model: this.d.model,
        system: `${PROACTIVE_SYSTEM}\n\nNow: ${describeNow(input.timeZone, input.now)}.`,
        messages: [{ role: 'user', content: prompt }],
      });
      return cleanProactiveText(r.text);
    } catch (e) {
      this.d.log.warn({ err: (e as Error).name }, 'proactive composition failed; using fallback');
      return cleanProactiveText(
        fallbackFollowUp(
          {
            id: input.chosen.id,
            kind: input.chosen.kind,
            summary: input.chosen.summary,
            dueAt: input.chosen.dueAt,
          },
          input.score,
        ),
      );
    }
  }
}
