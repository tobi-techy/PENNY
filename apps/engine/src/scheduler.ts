import type { Logger } from './lib/logger.ts';

/**
 * Tiny in-process scheduler for periodic crew jobs (expiry, pruning,
 * reflections, briefs). Jobs are due-checked on each tick; a failing job
 * never blocks the others. No persistence: on restart, due jobs just run
 * on the first tick, which is safe because every job here is idempotent.
 */
export type ScheduledJob = {
  name: string;
  everyMs: number;
  run: (now: Date) => Promise<void>;
};

export class Scheduler {
  private readonly lastRun = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly jobs: ScheduledJob[],
    private readonly log: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Run every due job once. Returns the names that ran and that failed. */
  async tick(at?: Date): Promise<{ ran: string[]; failed: string[] }> {
    const now = at ?? this.now();
    const ran: string[] = [];
    const failed: string[] = [];
    for (const job of this.jobs) {
      const last = this.lastRun.get(job.name) ?? Number.NEGATIVE_INFINITY;
      if (now.getTime() - last < job.everyMs) continue;
      this.lastRun.set(job.name, now.getTime());
      ran.push(job.name);
      try {
        await job.run(now);
      } catch (e) {
        failed.push(job.name);
        this.log.error({ err: (e as Error).name, job: job.name }, 'scheduled job failed');
      }
    }
    return { ran, failed };
  }

  start(intervalMs = 15_000): void {
    if (this.timer) return;
    // Anchor long-interval jobs (weekly reflection) to start time so they do
    // not fire immediately on every boot. Manual tick() still runs due jobs.
    const nowMs = this.now().getTime();
    for (const job of this.jobs) {
      if (job.everyMs >= 24 * 60 * 60_000 && !this.lastRun.has(job.name)) {
        this.lastRun.set(job.name, nowMs);
      }
    }
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

export type SchedulerJobDeps = {
  expireApprovals: (now: Date) => Promise<unknown>;
  refreshRelayed?: () => Promise<unknown>;
  pruneWebhookEvents: (olderThan: Date) => Promise<void>;
  pruneIdempotency: (olderThan: Date) => Promise<void>;
  weeklyReflection?: (now: Date) => Promise<void>;
};

/** Default Phase 1 jobs. Weekly reflection is weekly; the rest are hygiene. */
export function defaultJobs(d: SchedulerJobDeps): ScheduledJob[] {
  const jobs: ScheduledJob[] = [
    {
      name: 'expire_approvals',
      everyMs: 15_000,
      run: async (now) => void (await d.expireApprovals(now)),
    },
    {
      name: 'prune_webhook_events',
      everyMs: HOUR,
      run: async (now) => d.pruneWebhookEvents(new Date(now.getTime() - 48 * HOUR)),
    },
    {
      name: 'prune_idempotency_keys',
      everyMs: HOUR,
      run: async (now) => d.pruneIdempotency(new Date(now.getTime() - DAY)),
    },
  ];
  if (d.refreshRelayed) {
    jobs.push({
      name: 'chain_status_poller',
      everyMs: 30_000,
      run: async () => void (await d.refreshRelayed?.()),
    });
  }
  if (d.weeklyReflection) {
    jobs.push({ name: 'weekly_reflection', everyMs: 7 * DAY, run: d.weeklyReflection });
  }
  return jobs;
}
