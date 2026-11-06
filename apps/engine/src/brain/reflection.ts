import type { BotsRepo } from '../repo/bots.ts';
import type { UsersRepo } from '../repo/users.ts';
import type { MemoryService } from './memory.ts';

const WEEK_MS = 7 * 24 * 60 * 60_000;
const REASON = 'weekly_reflection';
const PAGE = 200;

/**
 * Weekly reflection (IDEA §6): review what was learned this week and log it
 * to souls_changelog, readable by the user. It records memory-derived notes
 * only; it never edits a soul's rules, caps or tools on its own.
 *
 * Idempotent: the last reflection row per user is the watermark, so a user is
 * reflected at most once a week and only for memories newer than the last
 * reflection. Restarts and re-runs do not append duplicates.
 */
export class ReflectionService {
  constructor(
    private readonly deps: {
      users: UsersRepo;
      bots: BotsRepo;
      memory: MemoryService;
    },
  ) {}

  /** Reflect for every user who is due and has new memories. Returns users reflected for. */
  async reflectWeekly(now = new Date()): Promise<number> {
    const penny = await this.deps.bots.builtIn('penny');
    if (!penny) return 0;
    let reflected = 0;
    let after: string | undefined;
    for (;;) {
      const ids = await this.deps.users.listIds(PAGE, after);
      for (const userId of ids) {
        const last = await this.deps.bots.lastSoulChangeAt(penny.id, userId, REASON);
        if (last && now.getTime() - last.getTime() < WEEK_MS) continue;
        const weekAgo = now.getTime() - WEEK_MS;
        const since = new Date(Math.max(weekAgo, last ? last.getTime() + 1 : weekAgo));
        const learned = await this.deps.memory.learnedSince(userId, since, 10);
        if (!learned.length) continue;
        const summary = learned.map((m) => `(${m.kind}) ${m.text.slice(0, 120)}`).join('; ');
        await this.deps.bots.logSoulChange(
          penny.id,
          userId,
          `weekly reflection: learned ${learned.length} thing(s): ${summary}`.slice(0, 2000),
          REASON,
        );
        reflected += 1;
      }
      if (ids.length < PAGE) break;
      after = ids[ids.length - 1];
    }
    return reflected;
  }
}
