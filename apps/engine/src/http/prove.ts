import { type MoneyPlan, SendPlan } from '@penny/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import type { ApprovalService } from '../approvals/service.ts';
import type { MarketPort } from '../brain/registry.ts';
import { constantTimeEqual } from '../lib/crypto.ts';
import type { SpaceRef } from '../ports/messaging.ts';
import type { UsersRepo } from '../repo/users.ts';
import type { AppVars } from './security.ts';

/**
 * Testnet proof routes for `bun run prove` (scripts/prove.ts). Off unless
 * PENNY_PROVE_SECRET is set, and the engine refuses to boot with it on mainnet.
 *
 * They only do what the iMessage path does after the model: bind a prove user to a
 * testnet account + test device key, and ask for a send approval through the same
 * Guard and approval code. Approving still goes through POST /v1/approvals/:id/sign
 * with every server check (challenge, hash, device signature, byte-for-byte action).
 * Binding an account here moves nothing: the relay path only accepts actions signed by
 * a full-access key of that account.
 */
export type ProveDeps = {
  secret: string;
  users: UsersRepo;
  approvals: ApprovalService;
  market: MarketPort;
};

const PROVE_HANDLE = (accountId: string) => `prove:${accountId}`;
const proveSpace = (accountId: string): SpaceRef => ({
  spaceId: `prove;-;${accountId}`,
  userHandle: PROVE_HANDLE(accountId),
});

export function buildProveRoutes(d: ProveDeps): Hono<{ Variables: AppVars }> {
  const r = new Hono<{ Variables: AppVars }>();

  r.use('/v1/prove/*', async (c, next) => {
    const m = /^Bearer (.+)$/.exec(c.req.header('authorization') ?? '');
    if (!m?.[1] || !constantTimeEqual(m[1], d.secret))
      return c.json({ error: 'unauthorized' }, 401);
    return next();
  });

  const Enroll = z
    .object({
      accountId: z.string().min(2).max(64),
      publicKeyEd25519: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    })
    .strict();

  r.post('/v1/prove/enroll', async (c) => {
    const body = Enroll.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    const user = await d.users.findOrCreateByHandle(PROVE_HANDLE(body.data.accountId));
    let device = await d.users.activeDevice(user.id);
    if (!device || device.publicKey !== body.data.publicKeyEd25519) {
      if (device) await d.users.revokeDevice(device.id);
      device = await d.users.addDevice(user.id, body.data.publicKeyEd25519);
    }
    await d.users.setAccount(user.id, user.slug ?? 'prove', body.data.accountId, false);
    return c.json({ userId: user.id, deviceId: device.id });
  });

  r.post('/v1/prove/approval', async (c) => {
    const body = z
      .object({ accountId: z.string().min(2).max(64), plan: SendPlan })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'bad_request' }, 400);
    const user = await d.users.findOrCreateByHandle(PROVE_HANDLE(body.data.accountId));
    const plan: MoneyPlan = body.data.plan;
    let price: bigint | undefined;
    if (plan.asset === 'NEAR' && d.market.nearUsdPriceMicros) {
      price = await d.market.nearUsdPriceMicros().catch(() => undefined);
    }
    const r2 = await d.approvals.createMoneyApproval({
      userId: user.id,
      bot: null,
      plan,
      space: proveSpace(body.data.accountId),
      ...(price !== undefined ? { nearUsdPriceMicros: price } : {}),
    });
    return c.json(r2);
  });

  return r;
}
