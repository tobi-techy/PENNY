import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LanguageModel } from 'ai';
import { type Context, Hono } from 'hono';
import { ApprovalService, type Clock } from './approvals/service.ts';
import { resolveBillers } from './bills/billers.ts';
import { BillsService } from './bills/service.ts';
import { DEFAULT_TIME_ZONE } from './bills/time.ts';
import type { PrivacyGate } from './brain/attestation.ts';
import { BotService } from './brain/bots.ts';
import { Crew } from './brain/crew.ts';
import { type Embedder, MemoryService } from './brain/memory.ts';
import { MoodService } from './brain/mood.ts';
import { ReflectionService } from './brain/reflection.ts';
import type { MarketPort, ToolRegistry } from './brain/registry.ts';
import { noopTracer, type Tracer } from './brain/tracing.ts';
import type { ConnectorPort } from './connectors/composio.ts';
import type { Db } from './db/client.ts';
import { EnrollService } from './devices/enroll.ts';
import { buildRoutes } from './http/routes.ts';
import {
  type AppVars,
  accessLog,
  clientIp,
  errorHandler,
  RateLimiter,
  rateLimit,
  securityMiddleware,
} from './http/security.ts';
import { handleInbound } from './inbound.ts';
import type { Logger } from './lib/logger.ts';
import type { InvestPort } from './market/invest.ts';
import { OnboardingService } from './onboarding.ts';
import type { ChainPort } from './ports/chain.ts';
import type { MessagingPort } from './ports/messaging.ts';
import { ApprovalsRepo } from './repo/approvals.ts';
import { BillsRepo, RemindersRepo } from './repo/bills.ts';
import { BotsRepo, MessagesRepo, MoodsRepo } from './repo/bots.ts';
import { ConnectWatchesRepo } from './repo/connect-watches.ts';
import {
  AttestChallengesRepo,
  GuardDecisionsRepo,
  IdempotencyRepo,
  WebhookEventsRepo,
} from './repo/infra.ts';
import { LedgerRepo } from './repo/ledger.ts';
import { UsersRepo } from './repo/users.ts';
import { defaultJobs, Scheduler } from './scheduler.ts';

export type EngineDeps = {
  db: Db;
  chain: ChainPort;
  messaging: MessagingPort;
  models: { router: LanguageModel; chat: LanguageModel };
  embedder: Embedder;
  market: MarketPort;
  registry: ToolRegistry;
  connectors?: ConnectorPort;
  attestAppId?: string;
  attestRequire?: boolean;
  log: Logger;
  publicBaseUrl: string;
  mainnetMaxPerTxUsd?: string;
  mainnetMaxDailyUsd?: string;
  relayerMaxDepositYocto?: bigint;
  invest?: InvestPort;
  webhookSecret: string | undefined;
  limits: { perIpPerMin: number; perUserPerMin: number; maxBodyBytes: number };
  tracer?: Tracer;
  now?: Clock;
  /** NEAR AI TEE attestation (NEARAI_ATTESTATION warn|enforce); absent = off. */
  privacy?: PrivacyGate;
  /** User-facing IANA time zone for reminders and "now" (PENNY_TIMEZONE). */
  timeZone?: string;
  /** NEAR account of the demo biller (PENNY_DEMO_BILLER_ACCOUNT); unset = no demo biller. */
  demoBillerAccount?: string;
};

const APP_LABELS: Record<string, string> = { gmail: 'Gmail', github: 'GitHub' };

const CONNECTED_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{{app}} connected · Penny</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;max-width:28rem;margin:18vh auto;padding:0 1.5rem;color:#111;line-height:1.5}h1{font-size:1.5rem;margin:0 0 .5rem}p{color:#555}</style>
</head><body><h1>{{app}} connected ✓</h1><p>You can close this and go back to Messages. Penny will text you in a moment.</p></body></html>`;

export function createEngine(d: EngineDeps) {
  const now = d.now ?? (() => new Date());
  const repos = {
    users: new UsersRepo(d.db),
    approvals: new ApprovalsRepo(d.db),
    ledger: new LedgerRepo(d.db),
    bots: new BotsRepo(d.db),
    moods: new MoodsRepo(d.db),
    messages: new MessagesRepo(d.db),
    webhookEvents: new WebhookEventsRepo(d.db),
    attestChallenges: new AttestChallengesRepo(d.db),
    idempotency: new IdempotencyRepo(d.db),
    guardDecisions: new GuardDecisionsRepo(d.db),
    bills: new BillsRepo(d.db),
    reminders: new RemindersRepo(d.db),
    connectWatches: new ConnectWatchesRepo(d.db),
  };
  const timeZone = d.timeZone ?? DEFAULT_TIME_ZONE;
  const mood = new MoodService(repos.moods);
  const memory = new MemoryService(d.db, d.embedder);

  let approvals: ApprovalService | null = null;
  const botService = new BotService({
    bots: repos.bots,
    users: repos.users,
    guardDecisions: repos.guardDecisions,
    registry: d.registry,
    mood,
    approvals: () => {
      if (!approvals) throw new Error('approvals not ready');
      return approvals;
    },
  });
  approvals = new ApprovalService({
    approvals: repos.approvals,
    ledger: repos.ledger,
    users: repos.users,
    bots: repos.bots,
    guardDecisions: repos.guardDecisions,
    chain: d.chain,
    messaging: d.messaging,
    mood,
    log: d.log,
    publicBaseUrl: d.publicBaseUrl,
    ...(d.mainnetMaxPerTxUsd ? { mainnetMaxPerTxUsd: d.mainnetMaxPerTxUsd } : {}),
    ...(d.mainnetMaxDailyUsd ? { mainnetMaxDailyUsd: d.mainnetMaxDailyUsd } : {}),
    ...(d.relayerMaxDepositYocto !== undefined
      ? { relayerMaxDepositYocto: d.relayerMaxDepositYocto }
      : {}),
    ...(d.invest ? { invest: d.invest } : {}),
    now,
    ...(d.connectors
      ? {
          executeWrite: (
            userId: string,
            toolkit: string,
            slug: string,
            args: Record<string, unknown>,
          ) =>
            d.connectors?.executeWrite(userId, toolkit, slug, args) ??
            Promise.reject(new Error('no connector')),
        }
      : {}),
    onBotApproved: (id) => botService.onApprovalSettled(id),
    onBillPaid: (userId, billId) => bills.markPaid(userId, billId),
    onNeedsSetup: async (userId, space) => {
      await onboarding.sendSetupLink(userId, space);
    },
    onBotDeclined: (id) => botService.onApprovalDeclined(id),
  });
  const enroll: EnrollService = new EnrollService(
    repos.users,
    d.chain,
    now,
    {
      ...(d.attestAppId ? { appId: d.attestAppId } : {}),
      require: d.attestRequire ?? false,
      challenges: repos.attestChallenges,
    },
    (userId): Promise<void> => onboarding.onEnrolled(userId),
  );
  const bills = new BillsService({
    bills: repos.bills,
    reminders: repos.reminders,
    users: repos.users,
    messages: repos.messages,
    messaging: d.messaging,
    ...(d.connectors ? { connectors: d.connectors } : {}),
    approvals: repos.approvals,
    billers: resolveBillers({ demoPayTo: d.demoBillerAccount }),
    log: d.log,
    timeZone,
    now,
  });
  const onboarding: OnboardingService = new OnboardingService({
    users: repos.users,
    messages: repos.messages,
    messaging: d.messaging,
    enroll,
    watches: repos.connectWatches,
    ...(d.connectors ? { connectors: d.connectors } : {}),
    bills,
    publicBaseUrl: d.publicBaseUrl,
    log: d.log,
    now,
  });
  const crew = new Crew({
    router: d.models.router,
    chat: d.models.chat,
    registry: d.registry,
    ...(d.connectors ? { connectors: d.connectors } : {}),
    bots: repos.bots,
    messages: repos.messages,
    users: repos.users,
    approvals,
    memory,
    mood,
    market: d.market,
    botOps: {
      draft: (u, p, s) => botService.draft(u, p, s),
      confirm: (u, s) => botService.confirm(u, s),
    },
    tracer: d.tracer ?? noopTracer,
    log: d.log,
    ...(d.privacy ? { privacy: d.privacy } : {}),
    bills,
    onboarding,
    timeZone,
    now,
  });

  const ipLimiter = new RateLimiter(d.limits.perIpPerMin, 60_000);
  const userLimiter = new RateLimiter(d.limits.perUserPerMin, 60_000);
  const app = new Hono<{ Variables: AppVars }>();
  for (const m of securityMiddleware({ maxBodyBytes: d.limits.maxBodyBytes })) app.use('*', m);
  app.use('*', accessLog(d.log));
  app.use(
    '/v1/*',
    rateLimit(ipLimiter, (c) => `ip:${clientIp(c)}`),
  );
  app.onError(errorHandler(d.log));

  // No-install web pages (apps/web build): /setup creates a browser key,
  // /a/:id is the approval page. Served only when the build exists.
  const webDist = join(process.cwd(), 'apps/web/dist');
  const spa = async (c: Context) => {
    const index = join(webDist, 'index.html');
    if (!existsSync(index)) return c.json({ error: 'web_not_built' }, 503);
    return c.html(await readFile(index, 'utf8'));
  };
  app.get('/setup', spa);
  app.get('/a/:id', spa);
  app.get('/assets/:file', async (c) => {
    const name = c.req.param('file').replace(/[^A-Za-z0-9._-]/g, '');
    const file = join(webDist, 'assets', name);
    if (!existsSync(file)) return c.json({ error: 'not_found' }, 404);
    const type = name.endsWith('.js')
      ? 'text/javascript'
      : name.endsWith('.css')
        ? 'text/css'
        : 'application/octet-stream';
    return new Response(await readFile(file), { headers: { 'content-type': type } });
  });

  // Where the browser lands after connecting an app. Static: Penny confirms in the thread.
  app.get('/connected', (c) => {
    const label = APP_LABELS[c.req.query('app') ?? ''] ?? 'Your app';
    return c.html(CONNECTED_HTML.replaceAll('{{app}}', label));
  });

  app.notFound((c) => c.json({ error: 'not_found' }, 404));

  const inboundDeps = {
    users: repos.users,
    messages: repos.messages,
    crew,
    onboarding,
    messaging: d.messaging,
    userLimiter,
    log: d.log,
  };
  app.route(
    '/',
    buildRoutes({
      approvals,
      approvalsRepo: repos.approvals,
      users: repos.users,
      enroll,
      ...(d.attestAppId ? { attestAppId: d.attestAppId } : {}),
      webhookEvents: repos.webhookEvents,
      idempotency: repos.idempotency,
      webhookSecret: d.webhookSecret,
      onInbound: (evt) => handleInbound(inboundDeps, evt),
      enrollLimiter: new RateLimiter(10, 60_000),
      approvalLimiter: new RateLimiter(60, 60_000),
      ...(d.privacy ? { privacy: d.privacy } : {}),
      log: d.log,
    }),
  );

  const reflection = new ReflectionService({ users: repos.users, bots: repos.bots, memory });
  const scheduler = new Scheduler(
    defaultJobs({
      expireApprovals: () => approvals.expireDue(),
      refreshRelayed: () => approvals.refreshRelayed(),
      pruneWebhookEvents: (olderThan) => repos.webhookEvents.prune(olderThan),
      pruneIdempotency: (olderThan) => repos.idempotency.prune(olderThan),
      weeklyReflection: async (now) => {
        await reflection.reflectWeekly(now);
      },
      sendReminders: async () => {
        await bills.sendDue();
      },
      ...(d.connectors
        ? {
            scanBills: async () => {
              await bills.scanAll();
            },
            checkConnections: async () => {
              await onboarding.checkConnections();
            },
          }
        : {}),
    }),
    d.log,
    now,
  );

  return {
    app,
    repos,
    services: {
      approvals,
      bills,
      onboarding,
      bots: botService,
      crew,
      enroll,
      mood,
      memory,
      reflection,
      scheduler,
    },
  };
}

export type Engine = ReturnType<typeof createEngine>;
