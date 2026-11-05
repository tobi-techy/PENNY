import type { Mood, MoodsRepo } from '../repo/bots.ts';

/**
 * Mood is driven by events, never by the model directly.
 * Mood shapes tone and card art. It NEVER changes money rules.
 */
export type MoodEvent =
  | 'message_received'
  | 'reply_sent'
  | 'approval_created'
  | 'approval_settled'
  | 'approval_failed'
  | 'approval_declined'
  | 'approval_expired'
  | 'guard_blocked'
  | 'bot_created'
  | 'playful';

export const MOOD_FOR_EVENT: Record<MoodEvent, Mood> = {
  message_received: 'thinking',
  reply_sent: 'idle',
  approval_created: 'thinking',
  approval_settled: 'win',
  approval_failed: 'blocked',
  approval_declined: 'paused',
  approval_expired: 'paused',
  guard_blocked: 'blocked',
  bot_created: 'done',
  playful: 'wink',
};

export class MoodService {
  constructor(private readonly repo: MoodsRepo) {}

  async on(userId: string, event: MoodEvent, botSlug = 'penny'): Promise<Mood> {
    const mood = MOOD_FOR_EVENT[event];
    await this.repo.set(userId, botSlug, mood, event);
    return mood;
  }

  get(userId: string, botSlug = 'penny'): Promise<Mood> {
    return this.repo.get(userId, botSlug);
  }
}
