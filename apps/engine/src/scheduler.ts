import type { Logger } from './lib/logger.ts';

/**
 * Tiny in-process scheduler for periodic crew jobs (expiry, pruning,
 * reflections, briefs). Jobs are due-checked on each tick; a failing job
 * never blocks the others. No persistence: on restart, due jobs just run
 * on the first tick, which is safe because every job here is idempotent
 * (weekly reflection keeps its own per-user watermark in souls_changelog).
 */
export type ScheduledJob = {
  name: string;
  everyMs: number;
  /** Wait a full interval after boot instead of running on the first tick. */
  anchorOnStart?: boolean;
  run: (now: Date) => Promise<void>;
};

export class Scheduler {
  private readonly lastRun = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** A slow tick must not stack a second copy on top of itself. */
  private ticking = false;

  constructor(
    private readonly jobs: ScheduledJob[],
    private readonly log: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Run every due job once. Returns the names that ran and that failed. */
  async tick(at?: Date): Promise<{ ran: string[]; failed: string[] }> {
    if (this.ticking) return { ran: [], failed: [] };
    this.ticking = true;
    try {
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
    } finally {
      this.ticking = false;
    }
  }

  start(intervalMs = 15_000): void {
    if (this.timer) return;
    // Anchor jobs that must not run on boot (a full inbox scan for every deploy)
    // and long-interval jobs (weekly reflection). Manual tick() still runs due jobs.
    const nowMs = this.now().getTime();
    for (const job of this.jobs) {
      if ((job.anchorOnStart || job.everyMs >= 24 * 60 * 60_000) && !this.lastRun.has(job.name)) {
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
  /** Send reminders that are due (each exactly once). */
  fireReminders?: (now: Date) => Promise<unknown>;
  refreshRelayed?: () => Promise<unknown>;
  /** Release approvals stuck in `signed` after a relay that never reported back. */
  reconcileStuckSigned?: () => Promise<unknown>;
  pruneWebhookEvents: (olderThan: Date) => Promise<void>;
  pruneIdempotency: (olderThan: Date) => Promise<void>;
  weeklyReflection?: (now: Date) => Promise<void>;
  /** Check connected inboxes for new bills and tell the user. */
  scanBills?: () => Promise<void>;
  /** One quiet check when an expected bill has not arrived. */
  commitmentFollowUps?: (now: Date) => Promise<unknown>;
  /** Notice apps the user just connected (after a connect link) and follow up. */
  checkConnections?: () => Promise<void>;
};

/** Default Phase 1 jobs. Weekly reflection is weekly; the rest are hygiene. */
export function defaultJobs(d: SchedulerJobDeps): ScheduledJob[] {
  const jobs: ScheduledJob[] = [
    {
      name: 'expire_approvals',
      // Below the 15s tick so timer jitter never skips a sweep.
      everyMs: 10_000,
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
  if (d.reconcileStuckSigned) {
    jobs.push({
      name: 'reconcile_stuck_signed',
      everyMs: 60_000,
      run: async () => void (await d.reconcileStuckSigned?.()),
    });
  }
  if (d.fireReminders) {
    const fire = d.fireReminders;
    jobs.push({
      name: 'fire_reminders',
      everyMs: 15_000,
      run: async (now) => void (await fire(now)),
    });
  }
  if (d.checkConnections) {
    // One live Composio call per pending watch: minute-scale, not tick-scale.
    jobs.push({ name: 'check_connections', everyMs: 60_000, run: d.checkConnections });
  }
  if (d.scanBills) {
    jobs.push({
      name: 'scan_bills',
      everyMs: 6 * HOUR,
      anchorOnStart: true,
      run: d.scanBills,
    });
  }
  if (d.commitmentFollowUps) {
    // The service itself only texts inside the 09:00 local hour, once per cycle.
    jobs.push({
      name: 'commitment_followups',
      everyMs: 15 * 60_000,
      run: async (now) => void (await d.commitmentFollowUps?.(now)),
    });
  }
  if (d.weeklyReflection) {
    // Checked hourly; the service itself only reflects users not reflected in 7 days.
    jobs.push({
      name: 'weekly_reflection',
      everyMs: HOUR,
      anchorOnStart: true,
      run: d.weeklyReflection,
    });
  }
  return jobs;
}
