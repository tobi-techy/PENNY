import { createHash } from 'node:crypto';
import {
  ApprovalId,
  CardPressBody,
  DeclineBody,
  deviceRevokeMessage,
  EnrollBody,
  historyRequestMessage,
  PasskeyApproveBody,
  policyUpdateMessage,
  SignBody,
  SpectrumMessagesEvent,
  UnfreezeBody,
} from '@penny/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { parseCardAuth } from '../approvals/card-token.ts';
import { ApprovalError, type ApprovalService } from '../approvals/service.ts';
import { type PrivacyGate, unverifiedStatus } from '../brain/attestation.ts';
import type { CardActions } from '../cards/actions.ts';
import { verifyAssertion } from '../devices/appattest.ts';
import { EnrollError, type EnrollService } from '../devices/enroll.ts';
import { verifyEd25519 } from '../lib/crypto.ts';
import type { Logger } from '../lib/logger.ts';
import { verifySpectrumSignature } from '../photon/verify.ts';
import { type ApprovalsRepo, ConcurrentTransitionError } from '../repo/approvals.ts';
import type { IdempotencyRepo, WebhookEventsRepo } from '../repo/infra.ts';
import type { DeviceRow, UsersRepo } from '../repo/users.ts';
import { withIdempotency } from './idempotency.ts';
import { type AppVars, clientIp, type RateLimiter, rateLimit } from './security.ts';

export type RouteDeps = {
  approvals: ApprovalService;
  approvalsRepo: ApprovalsRepo;
  cardActions: CardActions;
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
  /** NEAR AI TEE attestation gate; absent = NEARAI_ATTESTATION off. */
  privacy?: PrivacyGate;
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
  // A lost CAS race (double tap, two devices) is a conflict, not a server fault.
  // Unmapped it surfaced as 500 and the card told the user nothing had happened.
  if (e instanceof ConcurrentTransitionError)
    return { status: 409, body: { error: 'not_pending' } };
  throw e;
}

export function buildRoutes(d: RouteDeps): Hono<{ Variables: AppVars }> {
  const r = new Hono<{ Variables: AppVars }>();

  r.get('/', (c) => c.json({ name: 'penny', ok: true }));
  r.get('/healthz', (c) => c.json({ ok: true }));

  // ---- NEAR AI TEE attestation status (public, no user data) ----
  r.get('/v1/attestation', async (c) => {
    if (!d.privacy) return c.json(unverifiedStatus('off', '', null));
    return c.json(await d.privacy.status());
  });

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

    // Acknowledge fast; process after the response. On failure the row keeps
    // the error (audit trail) but stays unprocessed, so a redelivery reclaims
    // and reprocesses it. A crash leaves a stale claim, reclaimed after its TTL.
    // Links in replies always use PUBLIC_BASE_URL, never this request's Host header:
    // a crafted Host must never become a card link, and passkeys bind to that origin.
    queueMicrotask(() => {
      d.onInbound(parsed.data)
        .then(() => d.webhookEvents.markProcessed(dedupeKey))
        .catch(async (e: unknown) => {
          d.log.error({ err: (e as Error).name }, 'inbound processing failed, releasing claim');
          await d.webhookEvents.release(dedupeKey, (e as Error).name).catch(() => {});
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

  r.post(
    '/v1/devices/passkey/challenge',
    rateLimit(d.enrollLimiter, (c) => `pkc:${clientIp(c)}`),
    async (c) => {
      const body = parseJson(
        z.object({ enrollCode: z.string().min(4).max(32) }).strict(),
        await c.req.text(),
      );
      if (!body) return c.json({ error: 'bad_request' }, 400);
      const issued = await d.enroll.issuePasskeyChallenge(body.enrollCode);
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
      const approval = await d.approvals.get(id, parseCardAuth(c.req.header('authorization')));
      if (!d.privacy) return c.json(approval);
      // Card badge: cached status only, never a network call on the card path.
      const p = d.privacy.peek();
      return c.json({ ...approval, privateInference: { verified: p.verified, label: p.label } });
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

  // Retired: it had no challenge check. The app uses /sign, the link page /passkey.
  r.post('/v1/approvals/:id/submit', approvalsRL, (c) => c.json({ error: 'use_sign' }, 410));

  // ---- one card URL for both paths: /a/<cardToken> ----
  const tokenOf = (raw: string) => (/^[A-Za-z0-9_-]{43}$/.test(raw) ? raw : null);

  r.get('/v1/approvals/by-token/:token', approvalsRL, async (c) => {
    const token = tokenOf(c.req.param('token'));
    if (!token) return c.json({ error: 'unauthorized' }, 401);
    try {
      return c.json(await d.approvals.getByToken(token));
    } catch (e) {
      const r2 = asResult(e);
      return c.json(r2.body as object, r2.status as 401);
    }
  });

  r.post('/v1/approvals/by-token/:token/renew', approvalsRL, async (c) => {
    const token = tokenOf(c.req.param('token'));
    if (!token) return c.json({ error: 'unauthorized' }, 401);
    const raw = await c.req.text();
    return withIdempotency(c, d.idempotency, `renew:${token.slice(0, 12)}`, raw, async () => {
      try {
        return { status: 200, body: await d.approvals.renewByToken(token) };
      } catch (e) {
        return asResult(e);
      }
    });
  });

  // iOS app: Face ID unlocked the Keychain key; it signed approvalHash + challenge.
  r.post('/v1/approvals/:id/sign', approvalsRL, async (c) => {
    const id = idOf(c.req.param('id'));
    if (!id) return c.json({ error: 'unauthorized' }, 401);
    const raw = await c.req.text();
    const body = parseJson(SignBody, raw);
    if (!body) return c.json({ error: 'bad_request' }, 400);
    const token = parseCardAuth(c.req.header('authorization'));
    return withIdempotency(c, d.idempotency, `sign:${id}`, raw, async () => {
      try {
        return { status: 200, body: await d.approvals.signWithDevice(id, token, body) };
      } catch (e) {
        return asResult(e);
      }
    });
  });

  // No install: the WebAuthn assertion is verified here, on the server.
  r.post('/v1/approvals/:id/passkey', approvalsRL, async (c) => {
    const id = idOf(c.req.param('id'));
    if (!id) return c.json({ error: 'unauthorized' }, 401);
    const raw = await c.req.text();
    const body = parseJson(PasskeyApproveBody, raw);
    if (!body) return c.json({ error: 'bad_request' }, 400);
    const token = parseCardAuth(c.req.header('authorization'));
    return withIdempotency(c, d.idempotency, `passkey:${id}`, raw, async () => {
      try {
        return { status: 200, body: await d.approvals.approveWithPasskey(id, token, body) };
      } catch (e) {
        return asResult(e);
      }
    });
  });

  // ---- card buttons (info cards; Send turns a card into an approval card) ----
  r.post('/v1/cards/by-token/:token/press', approvalsRL, async (c) => {
    const token = tokenOf(c.req.param('token'));
    if (!token) return c.json({ error: 'unauthorized' }, 401);
    const raw = await c.req.text();
    const body = parseJson(CardPressBody, raw);
    if (!body) return c.json({ error: 'bad_request' }, 400);
    return withIdempotency(c, d.idempotency, `press:${token.slice(0, 12)}`, raw, async () => {
      try {
        return { status: 200, body: await d.cardActions.press(token, body.buttonId) };
      } catch (e) {
        return asResult(e);
      }
    });
  });

  // Face ID on an Unfreeze card (device key from the app, passkey from the web)
  r.post('/v1/cards/by-token/:token/unfreeze', approvalsRL, async (c) => {
    const token = tokenOf(c.req.param('token'));
    if (!token) return c.json({ error: 'unauthorized' }, 401);
    const raw = await c.req.text();
    const body = parseJson(UnfreezeBody, raw);
    if (!body) return c.json({ error: 'bad_request' }, 400);
    return withIdempotency(c, d.idempotency, `unfreeze:${token.slice(0, 12)}`, raw, async () => {
      try {
        return { status: 200, body: await d.approvals.unfreezeByToken(token, body) };
      } catch (e) {
        return asResult(e);
      }
    });
  });

  r.post('/v1/cards/by-token/:token/edit', approvalsRL, async (c) => {
    const token = tokenOf(c.req.param('token'));
    if (!token) return c.json({ error: 'unauthorized' }, 401);
    const raw = await c.req.text();
    const body = parseJson(z.object({ text: z.string().max(5000) }).strict(), raw);
    if (!body) return c.json({ error: 'bad_request' }, 400);
    return withIdempotency(c, d.idempotency, `edit:${token.slice(0, 12)}`, raw, async () => {
      try {
        return { status: 200, body: { card: await d.cardActions.editDraft(token, body.text) } };
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
