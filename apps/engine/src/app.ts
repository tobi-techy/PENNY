import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LanguageModel } from 'ai';
import { type Context, Hono } from 'hono';
import { ApprovalService, type Clock } from './approvals/service.ts';
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
import type { ChainPort } from './ports/chain.ts';
import type { MessagingPort } from './ports/messaging.ts';
import { ApprovalsRepo } from './repo/approvals.ts';
import { BotsRepo, MessagesRepo, MoodsRepo } from './repo/bots.ts';
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
};

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
  };
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
    onBotDeclined: (id) => botService.onApprovalDeclined(id),
  });
  const enroll = new EnrollService(repos.users, d.chain, now, {
    ...(d.attestAppId ? { appId: d.attestAppId } : {}),
    require: d.attestRequire ?? false,
    challenges: repos.attestChallenges,
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

  app.notFound((c) => c.json({ error: 'not_found' }, 404));

  const inboundDeps = {
    users: repos.users,
    messages: repos.messages,
    crew,
    enroll,
    messaging: d.messaging,
    userLimiter,
    log: d.log,
    publicBaseUrl: d.publicBaseUrl,
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
    }),
    d.log,
    now,
  );

  return {
    app,
    repos,
    services: { approvals, bots: botService, crew, enroll, mood, memory, reflection, scheduler },
  };
}

export type Engine = ReturnType<typeof createEngine>;
