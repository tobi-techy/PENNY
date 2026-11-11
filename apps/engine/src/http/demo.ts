import { PasskeyRegistration, type SpectrumMessagesEvent } from '@penny/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import type { CardSender } from '../cards/sender.ts';
import type { EnrollService } from '../devices/enroll.ts';
import { handleInbound, type InboundDeps } from '../inbound.ts';
import { sha256Hex } from '../lib/crypto.ts';
import type { Logger } from '../lib/logger.ts';
import { demoSpaceId } from '../ports/demo-messaging.ts';
import type { CardsRepo } from '../repo/cards.ts';
import type { DemoRepo } from '../repo/demo.ts';
import type { UsersRepo } from '../repo/users.ts';
import { type AppVars, clientIp, RateLimiter, rateLimit } from './security.ts';

/**
 * The public demo API (/demo). A judge gets a throwaway thread that runs the real
 * Crew, the real Guard, the real approval and the real card renderer. The only
 * simulated part is the NEAR account, which is never created: ports/demo-chain.ts
 * refuses to broadcast for it and answers the "is this key on chain" read from the
 * engine's own enrollment record.
 *
 * Off unless the engine booted with PENNY_DEMO_ACCOUNT and is not on mainnet.
 */
export type DemoDeps = {
  demo: DemoRepo;
  users: UsersRepo;
  enroll: EnrollService;
  /** The normal inbound pipeline, so a demo turn is the same code path as a text. */
  inbound: InboundDeps;
  cards: CardSender;
  cardsRepo: CardsRepo;
  log: Logger;
  now: () => Date;
  /** Model turns per session, so one visitor cannot run up an unbounded bill. */
  maxTurns: number;
  /** Sessions opened per IP per hour. */
  sessionsPerHour: number;
  /** Shared Guard contract (PENNY_GUARD_CONTRACT) for the policy panel. */
  guardContract?: string;
  explorerBaseUrl?: string;
};

/** What the page offers. Four things a judge can try without typing anything. */
export const DEMO_PROMPTS: { label: string; text: string; note: string }[] = [
  {
    label: 'Send $400 to someone new',
    text: 'send $400 to new-wallet.testnet',
    note: 'watch the Guard say no, for two separate reasons',
  },
  {
    label: 'Send $5 to a friend',
    text: 'send $5 to amara.testnet',
    note: 'an approval: Face ID, then the exact bytes get checked',
  },
  {
    label: 'Make me a bot',
    text: 'make me a bot that watches my github stars and tells me when one lands',
    note: 'agents get their own limits, not your account',
  },
  {
    label: 'What are my limits?',
    text: 'what are my spending limits?',
    note: 'the same policy the Guard enforces before any card',
  },
];

const DEMO_HANDLE = (sessionId: string) => `demo:${sessionId}`;

/** A throwaway account id: never created on chain, unique per session. */
export function demoAccountId(sessionId: string): string {
  return `demo-${sessionId.slice(0, 20).toLowerCase()}.testnet`;
}

const SessionId = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

const DemoEnrollBody = z
  .object({
    sessionId: SessionId,
    enrollCode: z.string().min(4).max(16),
    publicKeyEd25519: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    /** Optional: a browser with no passkey signs with its device key instead. */
    passkey: PasskeyRegistration.optional(),
    passkeyChallengeId: z.string().min(3).max(64).optional(),
  })
  .strict();

const SayBody = z.object({ sessionId: SessionId, text: z.string().min(1).max(400) }).strict();

export function buildDemoRoutes(d: DemoDeps): Hono<{ Variables: AppVars }> {
  const r = new Hono<{ Variables: AppVars }>();
  const sessionLimiter = new RateLimiter(d.sessionsPerHour, 60 * 60_000);
  const sayLimiter = new RateLimiter(30, 60_000);

  r.use(
    '/v1/demo/*',
    rateLimit(sessionLimiter, (c) => `demo:${clientIp(c)}`),
  );

  /**
   * Open a session. The enroll code comes back so the page can run the normal
   * passkey challenge; it is single use, tied to a throwaway user that cannot move
   * money, and it dies with the session.
   */
  r.post('/v1/demo/start', async (c) => {
    const now = d.now();
    const sessionId = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
    const handle = DEMO_HANDLE(sessionId);
    const accountId = demoAccountId(sessionId);
    const user = await d.users.findOrCreateByHandle(handle);
    await d.users.markDemo(user.id);
    await d.users.setAccount(user.id, `demo${sessionId.slice(0, 8)}`, accountId, true);
    await d.demo.create(sessionId, user.id, null, now);
    const { code, expiresAt } = await d.enroll.issue(user.id, handle);
    const policy = await d.users.policy(user.id);
    return c.json({
      sessionId,
      enrollCode: code,
      enrollExpiresAt: expiresAt.toISOString(),
      accountId,
      prompts: DEMO_PROMPTS,
      // The numbers behind every block a judge will see.
      policy: {
        perTxUsd: policy.perTxUsd,
        dailyUsd: policy.dailyUsd,
        blockNewRecipientsOverUsd: policy.blockNewRecipientsOverUsd,
      },
      ...(d.guardContract
        ? {
            guard: {
              contractId: d.guardContract,
              explorer: `${d.explorerBaseUrl ?? 'https://testnet.nearblocks.io'}/address/${d.guardContract}`,
            },
          }
        : {}),
      live: [
        'the Guard decision',
        'the approval and its expiry',
        'the signature check',
        'the card',
      ],
      simulated: ['the NEAR account', 'the broadcast'],
    });
  });

  /** Enroll this browser's key so it can approve. Same verifier as the phone path. */
  r.post('/v1/demo/enroll', async (c) => {
    const body = DemoEnrollBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    const session = await d.demo.get(body.data.sessionId, d.now());
    if (!session) return c.json({ error: 'session_expired' }, 410);
    const user = await d.users.byId(session.userId);
    if (!user?.isDemo || !user.accountId) return c.json({ error: 'not_found' }, 404);
    try {
      const res = await d.enroll.enrollDemo(
        {
          enrollCode: body.data.enrollCode,
          publicKeyEd25519: body.data.publicKeyEd25519,
          platform: 'web_passkey',
          ...(body.data.passkey ? { passkey: body.data.passkey } : {}),
          ...(body.data.passkeyChallengeId
            ? { passkeyChallengeId: body.data.passkeyChallengeId }
            : {}),
        },
        user.accountId,
      );
      return c.json({ accountId: res.accountId, status: res.status });
    } catch (e) {
      const err = e as { status?: number; code?: string };
      d.log.warn({ code: err.code }, 'demo enroll failed');
      return c.json({ error: err.code ?? 'enroll_failed' }, (err.status ?? 400) as 400);
    }
  });

  /** One turn of the real pipeline. Nothing inside it is special-cased for the demo. */
  r.post('/v1/demo/say', async (c) => {
    const body = SayBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    const now = d.now();
    const session = await d.demo.get(body.data.sessionId, now);
    if (!session) return c.json({ error: 'session_expired' }, 410);
    if (sayLimiter.take(session.id) > 0) return c.json({ error: 'slow_down' }, 429);
    const turns = await d.demo.spendTurn(session.id, d.maxTurns);
    if (turns === null) return c.json({ error: 'out_of_turns', maxTurns: d.maxTurns }, 429);

    const text = body.data.text.trim();
    await d.demo.add(session.id, { direction: 'inbound', kind: 'text', text });
    const evt: SpectrumMessagesEvent = {
      event: 'messages',
      space: { id: demoSpaceId(session.id), platform: 'demo', type: 'dm' },
      message: {
        id: `demo-${session.id.slice(0, 8)}-${turns}`,
        platform: 'demo',
        direction: 'inbound',
        timestamp: now.toISOString(),
        sender: { id: DEMO_HANDLE(session.id), platform: 'demo' },
        content: { type: 'text', text },
      },
    };
    try {
      await handleInbound(d.inbound, evt);
    } catch (e) {
      d.log.error({ err: (e as Error).name }, 'demo turn failed');
      await d.demo.add(session.id, {
        direction: 'outbound',
        kind: 'text',
        text: 'something went wrong on my side. try that again.',
      });
    }
    await settleDemoCards(d, session.id);
    return c.json({ turns, maxTurns: d.maxTurns, messages: await d.demo.thread(session.id) });
  });

  r.get('/v1/demo/thread', async (c) => {
    const session = await d.demo.get(c.req.query('session') ?? '', d.now());
    if (!session) return c.json({ error: 'session_expired' }, 410);
    return c.json({ messages: await d.demo.thread(session.id) });
  });

  return r;
}

/**
 * A demo approval is verified and then not broadcast, so its card sits at
 * "approving" in the real state machine. Close it with what actually happened, in
 * words, instead of leaving a spinner on a judge's screen.
 */
async function settleDemoCards(d: DemoDeps, sessionId: string): Promise<void> {
  for (const m of await d.demo.thread(sessionId)) {
    if (m.kind !== 'card' || !m.url) continue;
    const token = /\/a\/([A-Za-z0-9_-]{43})/.exec(m.url)?.[1];
    if (!token) continue;
    const row = await d.cardsRepo.byTokenHash(sha256Hex(token)).catch(() => null);
    if (row?.state !== 'approving') continue;
    await d.cards
      .update(row.id, { state: 'sent' }, { subcaption: 'verified. nothing was sent in this demo.' })
      .catch((e: unknown) => d.log.warn({ err: (e as Error).name }, 'demo card settle failed'));
  }
}
