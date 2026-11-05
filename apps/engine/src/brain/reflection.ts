import type { BotsRepo } from '../repo/bots.ts';
import type { UsersRepo } from '../repo/users.ts';
import type { MemoryService } from './memory.ts';

/**
 * Weekly reflection (IDEA §6): review what was learned this week and log it
 * to souls_changelog, readable by the user. It records memory-derived notes
 * only; it never edits a soul's rules, caps or tools on its own.
 */
export class ReflectionService {
  constructor(
    private readonly deps: {
      users: UsersRepo;
      bots: BotsRepo;
      memory: MemoryService;
    },
  ) {}

  /** Reflect for every user with new memories. Returns users reflected for. */
  async reflectWeekly(now = new Date()): Promise<number> {
    const penny = await this.deps.bots.builtIn('penny');
    if (!penny) return 0;
    const since = new Date(now.getTime() - 7 * 24 * 60 * 60_000);
    let reflected = 0;
    for (const userId of await this.deps.users.listIds(100)) {
      const learned = await this.deps.memory.learnedSince(userId, since, 10);
      if (!learned.length) continue;
      const summary = learned.map((m) => `(${m.kind}) ${m.text.slice(0, 120)}`).join('; ');
      await this.deps.bots.logSoulChange(
        penny.id,
        userId,
        `weekly reflection: learned ${learned.length} thing(s): ${summary}`.slice(0, 2000),
        'weekly_reflection',
      );
      reflected += 1;
    }
    return reflected;
  }
}
