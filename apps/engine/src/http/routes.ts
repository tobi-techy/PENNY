import { createHash } from 'node:crypto';
import {
  ApprovalId,
  DeclineBody,
  deviceRevokeMessage,
  EnrollBody,
  historyRequestMessage,
  policyUpdateMessage,
  SpectrumMessagesEvent,
  SubmitBody,
} from '@penny/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { parseCardAuth } from '../approvals/card-token.ts';
import { ApprovalError, type ApprovalService } from '../approvals/service.ts';
import { verifyAssertion } from '../devices/appattest.ts';
import { EnrollError, type EnrollService } from '../devices/enroll.ts';
import { verifyEd25519 } from '../lib/crypto.ts';
import type { Logger } from '../lib/logger.ts';
import { verifySpectrumSignature } from '../photon/verify.ts';
import type { ApprovalsRepo } from '../repo/approvals.ts';
import type { IdempotencyRepo, WebhookEventsRepo } from '../repo/infra.ts';
import type { DeviceRow, UsersRepo } from '../repo/users.ts';
import { withIdempotency } from './idempotency.ts';
import { type AppVars, clientIp, type RateLimiter, rateLimit } from './security.ts';

export type RouteDeps = {
  approvals: ApprovalService;
  approvalsRepo: ApprovalsRepo;
  users: UsersRepo;
  enroll: EnrollService;
  /** App Attest app id ("TEAMID.bundle.id"); assertions verified when set. */
  attestAppId?: string;
  webhookEvents: WebhookEventsRepo;
  idempotency: IdempotencyRepo;
  webhookSecret: string | undefined;
  onInbound: (evt: SpectrumMessagesEvent) => Promise<void>;
  enrollLimiter: RateLimiter;
  approvalLimiter: RateLimiter;
  log: Logger;
};

function parseJson<T extends z.ZodType>(schema: T, raw: string): z.infer<T> | null {
  let v: unknown;
  try {
    v = raw.length ? JSON.parse(raw) : {};
  } catch {
    return null;
  }
  const r = schema.safeParse(v);
  return r.success ? r.data : null;
}

function asResult(e: unknown): { status: number; body: unknown } {
  if (e instanceof ApprovalError || e instanceof EnrollError)
    return { status: e.status, body: { error: e.code } };
  throw e;
}

export function buildRoutes(d: RouteDeps): Hono<{ Variables: AppVars }> {
  const r = new Hono<{ Variables: AppVars }>();

  r.get('/healthz', (c) => c.json({ ok: true }));

  // ---- Photon / Spectrum webhook ----
  r.post('/v1/photon/webhook', async (c) => {
    if (!d.webhookSecret) return c.json({ error: 'webhook_not_configured' }, 503);
    const rawBody = await c.req.text(); // raw bytes BEFORE any parse
    const v = verifySpectrumSignature({
      secret: d.webhookSecret,
      rawBody,
      timestamp: c.req.header('x-spectrum-timestamp'),
      signature: c.req.header('x-spectrum-signature'),
    });
    if (!v.ok) return c.json({ error: v.reason }, v.status);

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return c.json({ error: 'bad_json' }, 400);
    }
    const event = (payload as { event?: unknown }).event;
    if (event !== 'messages') {
      d.log.info({ event: String(event).slice(0, 32) }, 'ignoring unknown spectrum event');
      return c.json({ ok: true });
    }
    const parsed = SpectrumMessagesEvent.safeParse(payload);
    if (!parsed.success) return c.json({ error: 'bad_payload' }, 400);
    const webhookId = (c.req.header('x-spectrum-webhook-id') ?? 'default').slice(0, 64);
    const dedupeKey = `${webhookId}:${parsed.data.message.id}`;
    const fresh = await d.webhookEvents.claim(dedupeKey, 'messages');
    if (!fresh) return c.json({ ok: true, duplicate: true });

    // Acknowledge fast; process after the response. On failure the claim is
    // released (not marked processed) so a redelivery reprocesses the event.
    // A crash leaves a stale claim, which claim() reclaims after its TTL.
    queueMicrotask(() => {
      d.onInbound(parsed.data)
        .then(() => d.webhookEvents.markProcessed(dedupeKey))
        .catch(async (e: unknown) => {
          d.log.error({ err: (e as Error).name }, 'inbound processing failed, releasing claim');
          await d.webhookEvents.release(dedupeKey).catch(() => {});
        });
    });
    return c.json({ ok: true });
  });

  // ---- devices ----
  r.post(
    '/v1/devices/enroll',
    rateLimit(d.enrollLimiter, (c) => `enroll:${clientIp(c)}`),
    async (c) => {
      const raw = await c.req.text();
      const body = parseJson(EnrollBody, raw);
      if (!body) return c.json({ error: 'bad_request' }, 400);
      return withIdempotency(c, d.idempotency, `enroll:${body.enrollCode}`, raw, async () => {
        try {
          return { status: 201, body: await d.enroll.enroll(body) };
        } catch (e) {
          return asResult(e);
        }
      });
    },
  );

  r.post(
    '/v1/devices/app-attest/challenge',
    rateLimit(d.enrollLimiter, (c) => `attest:${clientIp(c)}`),
    async (c) => {
      const body = parseJson(
        z.object({ enrollCode: z.string().min(4).max(32) }).strict(),
        await c.req.text(),
      );
      if (!body) return c.json({ error: 'bad_request' }, 400);
      const issued = await d.enroll.issueAttestChallenge(body.enrollCode);
      // unknown/expired codes look the same as everywhere else
      if (!issued) return c.json({ error: 'invalid_code' }, 401);
      return c.json(issued);
    },
  );

  // ---- approvals (Authorization: Card <token>) ----
  const approvalsRL = rateLimit(d.approvalLimiter, (c) => `apr:${clientIp(c)}`);
  const idOf = (raw: string) => (ApprovalId.safeParse(raw).success ? raw : null);

  r.get('/v1/approvals/:id', approvalsRL, async (c) => {
    const id = idOf(c.req.param('id'));
    if (!id) return c.json({ error: 'unauthorized' }, 401);
    try {
      return c.json(await d.approvals.get(id, parseCardAuth(c.req.header('authorization'))));
    } catch (e) {
      const r2 = asResult(e);
      return c.json(r2.body as object, r2.status as 401);
    }
  });

  r.get('/v1/approvals/:id/status', approvalsRL, async (c) => {
    const id = idOf(c.req.param('id'));
    if (!id) return c.json({ error: 'unauthorized' }, 401);
    try {
      return c.json(await d.approvals.status(id, parseCardAuth(c.req.header('authorization'))));
    } catch (e) {
      const r2 = asResult(e);
      return c.json(r2.body as object, r2.status as 401);
    }
  });

  r.post('/v1/approvals/:id/submit', approvalsRL, async (c) => {
    const id = idOf(c.req.param('id'));
    if (!id) return c.json({ error: 'unauthorized' }, 401);
    const raw = await c.req.text();
    const body = parseJson(SubmitBody, raw);
    if (!body) return c.json({ error: 'bad_request' }, 400);
    const token = parseCardAuth(c.req.header('authorization'));
    return withIdempotency(c, d.idempotency, `submit:${id}`, raw, async () => {
      try {
        return { status: 200, body: await d.approvals.submit(id, token, body) };
      } catch (e) {
        return asResult(e);
      }
    });
  });

  // ---- device-signed account operations (revoke, limits, history) ----
  const DeviceSigned = z
    .object({
      accountId: z.string().min(3).max(128),
      timestamp: z.number().int().positive(),
      signature: z.string().min(43).max(128),
      /** Required when the device has a verified App Attest credential. */
      appAssertion: z.string().max(8192).optional(),
    })
    .strict();
  const nowSec = () => Math.floor(Date.now() / 1000);

  async function verifyDeviceSigned(
    accountId: string,
    timestamp: number,
    signature: string,
    message: string,
    appAssertion?: string,
  ): Promise<{ userId: string; device: DeviceRow } | null> {
    if (Math.abs(nowSec() - timestamp) > 300) return null;
    const user = await d.users.byAccountId(accountId);
    if (!user) return null;
    const device = await d.users.activeDevice(user.id);
    if (!device) return null;
    const sig = Buffer.from(signature, 'base64url');
    if (!verifyEd25519(device.publicKey, new TextEncoder().encode(message), sig)) return null;
    // Verified App Attest devices must also present a fresh assertion over
    // this exact message, with a strictly increasing counter.
    if (device.appAttestVerified) {
      if (!appAssertion || !d.attestAppId || !device.appAttestPublicKey) return null;
      try {
        const clientDataHash = new Uint8Array(createHash('sha256').update(message).digest());
        const { counter } = verifyAssertion({
          assertionB64: appAssertion,
          publicKeyXY: device.appAttestPublicKey,
          clientDataHash,
          appId: d.attestAppId,
          lastCounter: device.appAttestCounter,
        });
        if (!(await d.users.advanceAttestCounter(device.id, counter))) return null;
      } catch {
        return null;
      }
    }
    return { userId: user.id, device };
  }

  r.post('/v1/devices/revoke', approvalsRL, async (c) => {
    const raw = await c.req.text();
    const body = parseJson(
      DeviceSigned.extend({ deviceId: z.string().min(3).max(64) }).strict(),
      raw,
    );
    if (!body) return c.json({ error: 'bad_request' }, 400);
    const auth = await verifyDeviceSigned(
      body.accountId,
      body.timestamp,
      body.signature,
      deviceRevokeMessage(body.accountId, body.deviceId, body.timestamp),
      body.appAssertion,
    );
    if (!auth) return c.json({ error: 'unauthorized' }, 401);
    // The signing device may revoke itself (lost-phone flow uses a second
    // enrolled device or the same device before it is wiped).
    if (auth.device.id !== body.deviceId) {
      const target = await d.users.deviceById(body.deviceId);
      if (!target || target.userId !== auth.userId) return c.json({ error: 'not_found' }, 404);
    }
    const ok = await d.users.revokeDevice(body.deviceId);
    return c.json({ revoked: ok, deviceId: body.deviceId }, ok ? 200 : 404);
  });

  r.post('/v1/me/guard-policy', approvalsRL, async (c) => {
    const raw = await c.req.text();
    const Money = z.string().regex(/^\d+(\.\d{1,6})?$/);
    const body = parseJson(
      DeviceSigned.extend({
        perTxUsd: Money,
        dailyUsd: Money,
        blockNewRecipientsOverUsd: Money,
      }).strict(),
      raw,
    );
    if (!body) return c.json({ error: 'bad_request' }, 400);
    const auth = await verifyDeviceSigned(
      body.accountId,
      body.timestamp,
      body.signature,
      policyUpdateMessage(
        body.accountId,
        body.perTxUsd,
        body.dailyUsd,
        body.blockNewRecipientsOverUsd,
        body.timestamp,
      ),
      body.appAssertion,
    );
    if (!auth) return c.json({ error: 'unauthorized' }, 401);
    const policy = await d.users.updatePolicy(auth.userId, {
      perTxUsd: body.perTxUsd,
      dailyUsd: body.dailyUsd,
      blockNewRecipientsOverUsd: body.blockNewRecipientsOverUsd,
    });
    return c.json({ policy });
  });

  r.post('/v1/me/approvals', approvalsRL, async (c) => {
    const raw = await c.req.text();
    const body = parseJson(DeviceSigned, raw);
    if (!body) return c.json({ error: 'bad_request' }, 400);
    const auth = await verifyDeviceSigned(
      body.accountId,
      body.timestamp,
      body.signature,
      historyRequestMessage(body.accountId, body.timestamp),
      body.appAssertion,
    );
    if (!auth) return c.json({ error: 'unauthorized' }, 401);
    const rows = await d.approvalsRepo.listForUser(auth.userId, 20);
    return c.json({
      approvals: rows.map((a) => ({
        id: a.id,
        kind: a.kind,
        title: a.title,
        amountDisplay: a.amountDisplay,
        status: a.status,
        txHash: a.txHash,
        createdAt: a.createdAt.toISOString(),
      })),
    });
  });

  r.post('/v1/approvals/:id/decline', approvalsRL, async (c) => {
    const id = idOf(c.req.param('id'));
    if (!id) return c.json({ error: 'unauthorized' }, 401);
    const raw = await c.req.text();
    const body = parseJson(DeclineBody, raw);
    if (!body) return c.json({ error: 'bad_request' }, 400);
    const token = parseCardAuth(c.req.header('authorization'));
    return withIdempotency(c, d.idempotency, `decline:${id}`, raw, async () => {
      try {
        return { status: 200, body: await d.approvals.decline(id, token, body.reason) };
      } catch (e) {
        return asResult(e);
      }
    });
  });

  return r;
}
