import { generateKeyPairSync, sign } from 'node:crypto';
import type { LanguageModel } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { createEngine, type Engine } from '../src/app.ts';
import { FakeEmbedder } from '../src/brain/memory.ts';
import { createRegistry, FakeMarket } from '../src/brain/tools.ts';
import { createPgliteDb, type DbHandle } from '../src/db/client.ts';
import { createLogger } from '../src/lib/logger.ts';
import { FakeChain } from '../src/ports/chain.ts';
import { FakeMessaging, type SpaceRef } from '../src/ports/messaging.ts';

export const WEBHOOK_SECRET = 'a'.repeat(64);

type Step = { text: string } | { tool: string; input: Record<string, unknown> };

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

let callSeq = 0;
function result(step: Step) {
  if ('text' in step) {
    return {
      content: [{ type: 'text', text: step.text }],
      finishReason: { unified: 'stop', raw: undefined },
      usage,
      warnings: [],
    };
  }
  callSeq += 1;
  return {
    content: [
      {
        type: 'tool-call',
        toolCallId: `call_${callSeq}`,
        toolName: step.tool,
        input: JSON.stringify(step.input),
      },
    ],
    finishReason: { unified: 'tool-calls', raw: undefined },
    usage,
    warnings: [],
  };
}

/** A model that plays back scripted steps, one per doGenerate call. */
export function scriptedModel(steps: Step[]): LanguageModel & { calls: () => number } {
  let i = 0;
  const m = new MockLanguageModelV4({
    doGenerate: async () => {
      const s = steps[Math.min(i, steps.length - 1)] ?? { text: '' };
      i += 1;
      return result(s) as never;
    },
  });
  return Object.assign(m as unknown as LanguageModel, { calls: () => i });
}

export type TestEngine = {
  engine: Engine;
  db: DbHandle;
  chain: FakeChain;
  messaging: FakeMessaging;
  clock: { now: Date };
  setModels: (router: LanguageModel, chat: LanguageModel) => void;
};

export async function makeEngine(
  opts: { router?: LanguageModel; chat?: LanguageModel } = {},
): Promise<TestEngine> {
  const db = await createPgliteDb();
  const chain = new FakeChain();
  const messaging = new FakeMessaging();
  const clock = { now: new Date('2026-11-05T19:00:00Z') };
  const models = {
    router: opts.router ?? scriptedModel([{ text: '' }]),
    chat: opts.chat ?? scriptedModel([{ text: 'ok' }]),
  };
  const build = () =>
    createEngine({
      db: db.db,
      chain,
      messaging,
      models,
      embedder: new FakeEmbedder(),
      market: new FakeMarket(() => clock.now),
      registry: createRegistry(),
      log: createLogger('silent'),
      publicBaseUrl: 'https://penny.test',
      webhookSecret: WEBHOOK_SECRET,
      limits: { perIpPerMin: 1000, perUserPerMin: 1000, maxBodyBytes: 65_536 },
      now: () => clock.now,
    });
  const t: TestEngine = {
    engine: build(),
    db,
    chain,
    messaging,
    clock,
    setModels: (router, chat) => {
      models.router = router;
      models.chat = chat;
      t.engine = build();
    },
  };
  await t.engine.services.bots.seedBuiltIns('/nonexistent');
  return t;
}

export function deviceKeys() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string };
  return {
    publicKeyB64Url: jwk.x,
    sign: (msg: string) => sign(null, Buffer.from(msg, 'utf8'), privateKey).toString('base64url'),
  };
}

/** A user who has enrolled a device and has an account. */
export async function enrolledUser(t: TestEngine, handle = '+15550100') {
  const user = await t.engine.repos.users.findOrCreateByHandle(handle);
  const keys = deviceKeys();
  const { code } = await t.engine.services.enroll.issue(user.id, handle);
  const r = await t.engine.services.enroll.enroll({
    enrollCode: code,
    publicKeyEd25519: keys.publicKeyB64Url,
  });
  const space: SpaceRef = { spaceId: `any;-;${handle}`, userHandle: handle };
  return { userId: user.id, accountId: r.accountId, keys, space };
}

export function idemKey() {
  return `k_${crypto.randomUUID().replaceAll('-', '')}`;
}
