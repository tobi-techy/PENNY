import { join } from 'node:path';
import { chainAdapterFromEnv } from '@penny/chain';
import type { LanguageModel } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { createEngine, type Engine } from './app.ts';
import { FakeEmbedder } from './brain/memory.ts';
import { NearAiEmbedder, nearAiModels } from './brain/model.ts';
import { createRegistry, FakeMarket } from './brain/tools.ts';
import { LangfuseTracer, noopTracer } from './brain/tracing.ts';
import { ComposioConnector } from './connectors/composio.ts';
import { createPgliteDb, createPostgresDb } from './db/client.ts';
import { loadEnv } from './env.ts';
import { createLogger } from './lib/logger.ts';
import { type ChainPort, FakeChain } from './ports/chain.ts';
import { FakeMessaging, type MessagingPort } from './ports/messaging.ts';
import { RealChain } from './ports/real-chain.ts';
import { SpectrumMessaging } from './ports/spectrum.ts';

const env = loadEnv();
const log = createLogger(env.LOG_LEVEL);

// Mainnet gate (deploy checklist): testnet E2E must have passed, live relay
// must be explicitly on, the RPC must be a mainnet endpoint, and the relayer
// key must be present. Anything missing fails closed at boot.
if (env.PENNY_ENV === 'mainnet') {
  const problems: string[] = [];
  if (env.PENNY_TESTNET_E2E_OK !== '1') problems.push('PENNY_TESTNET_E2E_OK is not 1');
  if (env.DRY_RUN !== '0') problems.push('DRY_RUN is not 0');
  if (!env.NEAR_RELAYER_PRIVATE_KEY) problems.push('NEAR_RELAYER_PRIVATE_KEY missing');
  if (!env.NEAR_RPC_URL || env.NEAR_RPC_URL.includes('testnet'))
    problems.push('NEAR_RPC_URL is not a mainnet endpoint');
  if (problems.length) {
    log.fatal({ problems }, 'mainnet boot refused');
    process.exit(1);
  }
}

const dbh = env.DATABASE_URL ? await createPostgresDb(env.DATABASE_URL) : await createPgliteDb();

let messaging: MessagingPort;
if (env.SPECTRUM_PROJECT_ID && env.SPECTRUM_PROJECT_SECRET && env.IMESSAGE_TEAM_ID) {
  messaging = new SpectrumMessaging({
    projectId: env.SPECTRUM_PROJECT_ID,
    projectSecret: env.SPECTRUM_PROJECT_SECRET,
    appName: env.IMESSAGE_APP_NAME,
    extensionBundleId: env.IMESSAGE_EXTENSION_BUNDLE_ID,
    teamId: env.IMESSAGE_TEAM_ID,
  });
} else {
  const fake = new FakeMessaging();
  const origText = fake.sendText.bind(fake);
  fake.sendText = async (s, t) => {
    log.debug(
      { to: s.userHandle.slice(-4), chars: t.length },
      `[fake imessage] ${t.slice(0, 200)}`,
    );
    await origText(s, t);
  };
  messaging = fake;
}

const offline = (): LanguageModel =>
  new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [
        { type: 'text', text: "i'm running without a brain (no NEARAI_API_KEY). set it in .env." },
      ],
      finishReason: { unified: 'stop', raw: undefined },
      usage: {
        inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 0, text: 0, reasoning: 0 },
      },
      warnings: [],
    }),
  }) as unknown as LanguageModel;

const nearCfg = env.NEARAI_API_KEY
  ? {
      baseURL: env.NEARAI_BASE_URL,
      apiKey: env.NEARAI_API_KEY,
      model: env.NEARAI_MODEL,
      routerModel: env.NEARAI_ROUTER_MODEL,
      embeddingModel: env.NEARAI_EMBEDDING_MODEL,
    }
  : null;

let engineRef: Engine | null = null;
const chain: ChainPort = env.NEAR_RPC_URL
  ? new RealChain(
      chainAdapterFromEnv(process.env, {
        resolveDeviceKey: async (signerId) => {
          if (!engineRef) return null;
          const user = await engineRef.repos.users.byAccountId(signerId);
          if (!user) return null;
          const device = await engineRef.repos.users.activeDevice(user.id);
          return device?.publicKey ?? null;
        },
      }),
    )
  : new FakeChain();

const engine = createEngine({
  db: dbh.db,
  chain,
  messaging,
  models: nearCfg ? nearAiModels(nearCfg) : { router: offline(), chat: offline() },
  embedder: nearCfg ? new NearAiEmbedder(nearCfg) : new FakeEmbedder(),
  market: new FakeMarket(),
  registry: createRegistry(),
  ...(env.COMPOSIO_API_KEY ? { connectors: new ComposioConnector(env.COMPOSIO_API_KEY) } : {}),
  log,
  publicBaseUrl: env.PUBLIC_BASE_URL,
  ...(env.PENNY_ENV === 'mainnet' ? { mainnetMaxPerTxUsd: env.PENNY_MAINNET_MAX_PER_TX_USD } : {}),
  webhookSecret: env.SPECTRUM_WEBHOOK_SECRET,
  limits: {
    perIpPerMin: env.RATE_LIMIT_PER_IP_PER_MIN,
    perUserPerMin: env.RATE_LIMIT_PER_USER_PER_MIN,
    maxBodyBytes: env.MAX_BODY_BYTES,
  },
  tracer:
    env.LANGFUSE_PUBLIC_KEY && env.LANGFUSE_SECRET_KEY
      ? new LangfuseTracer(env.LANGFUSE_BASE_URL, env.LANGFUSE_PUBLIC_KEY, env.LANGFUSE_SECRET_KEY)
      : noopTracer,
});

engineRef = engine;
await engine.services.bots.seedBuiltIns(join(import.meta.dir, '..', '..', '..', 'souls'));
// Phase 1 scheduler: approval expiry, webhook/idempotency pruning, weekly reflection.
engine.services.scheduler.start(15_000);

log.info(
  {
    env: env.PENNY_ENV,
    dryRun: env.DRY_RUN,
    relayLive: env.relayLive,
    composio: Boolean(env.COMPOSIO_API_KEY),
    port: env.PORT,
  },
  'penny engine up',
);

export default { port: env.PORT, fetch: engine.app.fetch };
