import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LanguageModel } from 'ai';
import { Hono } from 'hono';
import { ApprovalService, type Clock } from './approvals/service.ts';
import { resolveBillers } from './bills/billers.ts';
import { BillsService } from './bills/service.ts';
import { DEFAULT_TIME_ZONE } from './bills/time.ts';
import type { PrivacyGate } from './brain/attestation.ts';
import { BotService } from './brain/bots.ts';
import { Crew } from './brain/crew.ts';
import { type Embedder, MemoryService } from './brain/memory.ts';
import { MoodService } from './brain/mood.ts';
import { ProactiveService } from './brain/proactive.ts';
import { ReflectionService } from './brain/reflection.ts';
import type { MarketPort, ToolRegistry } from './brain/registry.ts';
import { noopTracer, type Tracer } from './brain/tracing.ts';
import { CardActions } from './cards/actions.ts';
import { CardSender, toCardDto } from './cards/sender.ts';
import type { ConnectorPort } from './connectors/composio.ts';
import type { Db } from './db/client.ts';
import { EnrollService } from './devices/enroll.ts';
import { buildProveRoutes } from './http/prove.ts';
import { buildRoutes } from './http/routes.ts';
import {
  type AppVars,
  accessLog,
  clientIp,
  errorHandler,
  RateLimiter,
  rateLimit,
  securityMiddleware,
  webPageCsp,
} from './http/security.ts';
import { handleInbound } from './inbound.ts';
import { sha256Hex } from './lib/crypto.ts';
import type { Logger } from './lib/logger.ts';
import type { InvestPort } from './market/invest.ts';
import { OnboardingService } from './onboarding.ts';
import type { ChainPort } from './ports/chain.ts';
import type { MessagingPort } from './ports/messaging.ts';
import { ApprovalsRepo } from './repo/approvals.ts';
import { BillsRepo } from './repo/bills.ts';
import { BotsRepo, MessagesRepo, MoodsRepo } from './repo/bots.ts';
import { CardsRepo, PasskeysRepo, RemindersRepo } from './repo/cards.ts';
import { ConnectWatchesRepo } from './repo/connect-watches.ts';
import {
  AttestChallengesRepo,
  GuardDecisionsRepo,
  IdempotencyRepo,
  WebhookEventsRepo,
} from './repo/infra.ts';
import { InstinctRepo } from './repo/instinct.ts';
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
  /** Learn durable facts from each finished turn. Default true; tests use false. */
  autoLearn?: boolean;
  /** Which NEAR network the chain adapter talks to. Testnet pays bills in tUSD. Default mainnet. */
  chainNetwork?: 'mainnet' | 'testnet';
  /** NEAR account of the demo biller (PENNY_DEMO_BILLER_ACCOUNT); unset = no demo biller. */
  demoBillerAccount?: string;
  /** PNG of a card (live card image + og:image). Absent: no image on live cards. */
  renderCardImage?: (card: import('@penny/shared').Card) => Promise<Uint8Array>;
  /** Explorer base for receipts, e.g. https://testnet.nearblocks.io */
  explorerBaseUrl?: string;
  /** Testnet proof routes (scripts/prove.ts). Only set from env on testnet. */
  proveSecret?: string;
  /** Test hook: no real waits between live-card edit retries. */
  sleep?: (ms: number) => Promise<void>;
};

const APP_LABELS: Record<string, string> = { gmail: 'Gmail', github: 'GitHub' };

const CONNECTED_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{{app}} connected · Penny</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;max-width:28rem;margin:18vh auto;padding:0 1.5rem;color:#111;line-height:1.5}h1{font-size:1.5rem;margin:0 0 .5rem}p{color:#555}</style>
</head><body><h1>{{app}} connected</h1><p>You can close this and go back to Messages. Penny will text you in a moment.</p></body></html>`;

export function createEngine(d: EngineDeps) {
  const now = d.now ?? (() => new Date());
  const repos = {
    users: new UsersRepo(d.db),
    approvals: new ApprovalsRepo(d.db, now),
    ledger: new LedgerRepo(d.db),
    bots: new BotsRepo(d.db),
    moods: new MoodsRepo(d.db),
    messages: new MessagesRepo(d.db),
    webhookEvents: new WebhookEventsRepo(d.db),
    attestChallenges: new AttestChallengesRepo(d.db),
    idempotency: new IdempotencyRepo(d.db),
    guardDecisions: new GuardDecisionsRepo(d.db),
    bills: new BillsRepo(d.db),
    connectWatches: new ConnectWatchesRepo(d.db),
    cards: new CardsRepo(d.db),
    passkeys: new PasskeysRepo(d.db),
    reminders: new RemindersRepo(d.db),
    instinct: new InstinctRepo(d.db),
  };
  const timeZone = d.timeZone ?? DEFAULT_TIME_ZONE;
  const cardSender = new CardSender({
    cards: repos.cards,
    users: repos.users,
    messaging: d.messaging,
    publicBaseUrl: d.publicBaseUrl,
    log: d.log,
    now,
    ...(d.renderCardImage ? { renderImage: d.renderCardImage } : {}),
    ...(d.sleep ? { sleep: d.sleep } : {}),
  });
  const mood = new MoodService(repos.moods);
  const memory = new MemoryService(d.db, d.embedder);
  const proactive = new ProactiveService({
    instinct: repos.instinct,
    users: repos.users,
    messages: repos.messages,
    messaging: d.messaging,
    model: d.models.chat,
    timeZone,
    now,
    log: d.log,
  });

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
    cards: cardSender,
    cardsRepo: repos.cards,
    passkeys: repos.passkeys,
    mood,
    log: d.log,
    publicBaseUrl: d.publicBaseUrl,
    ...(d.explorerBaseUrl ? { explorerBaseUrl: d.explorerBaseUrl } : {}),
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
    onBillPaid: (userId, billId, receipt) => bills.markPaid(userId, billId, receipt),
    recheckBill: (userId, billId) => bills.recheckBill(userId, billId),
    onNeedsSetup: async (userId, space) => {
      await onboarding.sendSetupLink(userId, space);
    },
    onBotDeclined: (id) => botService.onApprovalDeclined(id),
    onBotReissued: (from, to) => botService.onApprovalReissued(from, to),
  });
  const enroll: EnrollService = new EnrollService(
    repos.users,
    d.chain,
    now,
    {
      ...(d.attestAppId ? { appId: d.attestAppId } : {}),
      require: d.attestRequire ?? false,
      challenges: repos.attestChallenges,
      passkeys: repos.passkeys,
      publicBaseUrl: d.publicBaseUrl,
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
    explorerTxUrl: `${d.explorerBaseUrl ?? (d.chainNetwork === 'testnet' ? 'https://testnet.nearblocks.io' : 'https://nearblocks.io')}/txns/`,
    log: d.log,
    timeZone,
    now,
    onBillClosed: async (userId, billId) => {
      await approvals?.cancelPayBillApprovals(userId, billId);
    },
  });
  const onboarding: OnboardingService = new OnboardingService({
    users: repos.users,
    messages: repos.messages,
    messaging: d.messaging,
    enroll,
    watches: repos.connectWatches,
    cards: cardSender,
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
    autoLearn: d.autoLearn ?? true,
    ...(d.connectors ? { connectors: d.connectors } : {}),
    bots: repos.bots,
    messages: repos.messages,
    users: repos.users,
    approvals,
    memory,
    mood,
    instinct: proactive,
    market: d.market,
    botOps: {
      draft: (u, p, s) => botService.draft(u, p, s),
      confirm: (u, s) => botService.confirm(u, s),
    },
    everyday: { cards: cardSender, reminders: repos.reminders, now },
    tracer: d.tracer ?? noopTracer,
    log: d.log,
    ...(d.privacy ? { privacy: d.privacy } : {}),
    bills,
    onboarding,
    timeZone,
    now,
  });
  const cardActions = new CardActions({
    cards: repos.cards,
    sender: cardSender,
    approvals,
    reminders: repos.reminders,
    bots: repos.bots,
    now,
    log: d.log,
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
  // The SPA needs its own bundle and stylesheet; the strict API CSP would block both.
  app.use('/setup', webPageCsp());
  app.use('/a/:id', webPageCsp());
  const renderPng =
    d.renderCardImage ??
    (async (card: import('@penny/shared').Card) => {
      const { renderCardPng } = await import('./cards/render.ts');
      return renderCardPng(card, now());
    });
  // /setup is a picture link card too (sent before the user has any app).
  const base = d.publicBaseUrl.replace(/\/$/, '');
  app.get('/setup', async (c) => {
    const { linkPageHtml, SETUP_CARD } = await import('./cards/page.ts');
    const index = join(webDist, 'index.html');
    const shell = existsSync(index) ? await readFile(index, 'utf8') : null;
    c.header('cache-control', 'no-store');
    return c.html(
      linkPageHtml({
        shell,
        card: SETUP_CARD,
        imageUrl: `${base}/setup/card.png`,
        pageUrl: `${base}/setup`,
        now: now(),
      }),
    );
  });
  app.get('/setup/card.png', async () => {
    const { SETUP_CARD } = await import('./cards/page.ts');
    return new Response(await renderPng(SETUP_CARD), {
      headers: {
        'content-type': 'image/png',
        'cache-control': 'public, max-age=3600',
        'x-content-type-options': 'nosniff',
      },
    });
  });

  // Link card (no install): the page plus Open Graph tags, so iMessage shows the
  // card picture. The same token works for the iMessage extension (live card).
  const cardView = async (raw: string) => {
    if (!/^[A-Za-z0-9_-]{43}$/.test(raw)) return null;
    try {
      return await approvals.getByToken(raw);
    } catch {
      return null;
    }
  };
  app.get('/a/:token/card.png', async (c) => {
    const view = await cardView(c.req.param('token'));
    if (!view) return c.json({ error: 'not_found' }, 404);
    const png = await renderPng(view.card);
    return new Response(png, {
      headers: {
        'content-type': 'image/png',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
      },
    });
  });
  app.get('/a/:token', async (c) => {
    const raw = c.req.param('token');
    const view = await cardView(raw);
    const { linkPageHtml } = await import('./cards/page.ts');
    const index = join(webDist, 'index.html');
    const shell = existsSync(index) ? await readFile(index, 'utf8') : null;
    c.header('cache-control', 'no-store');
    c.header('referrer-policy', 'no-referrer');
    c.header('x-robots-tag', 'noindex');
    return c.html(
      linkPageHtml({
        shell,
        card: view?.card ?? null,
        imageUrl: view
          ? `${d.publicBaseUrl.replace(/\/$/, '')}/a/${raw}/card.png?v=${view.card.state}`
          : null,
        pageUrl: `${d.publicBaseUrl.replace(/\/$/, '')}/a/${raw}`,
        now: now(),
      }),
      view ? 200 : 404,
    );
  });
  /** Connect card: Penny-hosted so iMessage shows a real card, with one Continue
   *  button to the provider. The destination is stored server-side, never in the URL. */
  const connectCardView = async (raw: string) => {
    if (!/^[A-Za-z0-9_-]{43}$/.test(raw)) return null;
    const row = await repos.cards.byTokenHash(sha256Hex(raw));
    if (!row || row.type !== 'connect' || row.tokenExpiresAt.getTime() < now().getTime())
      return null;
    const connectUrl = typeof row.payload?.connectUrl === 'string' ? row.payload.connectUrl : null;
    if (!connectUrl || !connectUrl.startsWith('https://')) return null;
    return { card: toCardDto(row), connectUrl };
  };
  app.get('/c/:token/card.png', async (c) => {
    const view = await connectCardView(c.req.param('token'));
    if (!view) return c.json({ error: 'not_found' }, 404);
    const png = await renderPng(view.card);
    return new Response(png, {
      headers: {
        'content-type': 'image/png',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
      },
    });
  });
  app.get('/c/:token', async (c) => {
    const raw = c.req.param('token');
    const view = await connectCardView(raw);
    c.header('cache-control', 'no-store');
    c.header('referrer-policy', 'no-referrer');
    c.header('x-robots-tag', 'noindex');
    if (!view)
      return c.html(
        '<!doctype html><meta name="robots" content="noindex"><h1>This link is gone.</h1>',
        404,
      );
    const base = d.publicBaseUrl.replace(/\/$/, '');
    const { connectPageHtml } = await import('./cards/page.ts');
    return c.html(
      connectPageHtml({
        card: view.card,
        connectUrl: view.connectUrl,
        imageUrl: `${base}/c/${raw}/card.png`,
        pageUrl: `${base}/c/${raw}`,
      }),
    );
  });
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
  if (d.proveSecret) {
    app.route(
      '/',
      buildProveRoutes({
        secret: d.proveSecret,
        users: repos.users,
        approvals,
        market: d.market,
      }),
    );
  }

  app.notFound((c) => c.json({ error: 'not_found' }, 404));

  const inboundDeps = {
    users: repos.users,
    messages: repos.messages,
    crew,
    onboarding,
    messaging: d.messaging,
    userLimiter,
    log: d.log,
    publicBaseUrl: d.publicBaseUrl,
    approvals,
    proactive,
  };
  app.route(
    '/',
    buildRoutes({
      approvals,
      approvalsRepo: repos.approvals,
      cardActions,
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
      fireReminders: (at: Date) => bills.sendDue(at),
      instinctTick: (at: Date) => proactive.tick(at),
      refreshRelayed: () => approvals.refreshRelayed(),
      reconcileStuckSigned: () => approvals.reconcileStuckSigned(),
      pruneWebhookEvents: (olderThan) => repos.webhookEvents.prune(olderThan),
      pruneIdempotency: (olderThan) => repos.idempotency.prune(olderThan),
      weeklyReflection: async (now) => {
        await reflection.reflectWeekly(now);
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
      cards: cardSender,
      cardActions,
      crew,
      enroll,
      mood,
      memory,
      proactive,
      reflection,
      scheduler,
    },
  };
}

export type Engine = ReturnType<typeof createEngine>;
