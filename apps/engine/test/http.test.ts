import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { signSpectrum } from '../src/photon/verify.ts';
import {
  deviceKeys,
  idemKey,
  makeEngine,
  scriptedModel,
  type TestEngine,
  WEBHOOK_SECRET,
} from './helpers.ts';

let t: TestEngine;
beforeAll(async () => {
  t = await makeEngine({
    router: scriptedModel([{ tool: 'route', input: { bot: 'penny', reason: 'chat' } }]),
    chat: scriptedModel([{ text: 'hey tobi, all good 💸' }]),
  });
}, 120_000);
afterAll(async () => {
  await t?.db.close();
});

const tick = () => new Promise((r) => setTimeout(r, 50));

function event(msgId: string, text: string, from = '+15550100') {
  return JSON.stringify({
    event: 'messages',
    space: { id: `any;-;${from}`, platform: 'iMessage', type: 'dm', phone: 'shared' },
    message: {
      id: msgId,
      platform: 'iMessage',
      direction: 'inbound',
      timestamp: '2026-11-05T19:00:00.000Z',
      sender: { id: from, platform: 'iMessage' },
      content: { type: 'text', text },
      futureField: { ok: true },
    },
  });
}

function post(body: string, opts: { ts?: number; sig?: string; webhookId?: string } = {}) {
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  return t.engine.app.request('/v1/photon/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-spectrum-event': 'messages',
      'x-spectrum-webhook-id': opts.webhookId ?? '60d6d04f-f9fa-4a7b-9c97-37c9c90ce91c',
      'x-spectrum-timestamp': ts,
      'x-spectrum-signature': opts.sig ?? signSpectrum(WEBHOOK_SECRET, ts, body),
    },
    body,
  });
}

describe('POST /v1/photon/webhook', () => {
  test('valid delivery -> 200 fast, then welcome text and a separate setup link', async () => {
    const res = await post(event('spc-msg-1', 'hi penny'));
    expect(res.status).toBe(200);
    await tick();
    const texts = t.messaging.texts.map((x) => x.text);
    expect(texts.at(-2)).toContain('just talk to me here');
    expect(texts.at(-1)).toMatch(/^https:\/\/penny\.test\/setup#code=[A-Z2-9]{8}$/);
  });

  test('no install needed: an unenrolled user who keeps texting reaches the crew', async () => {
    await post(event('spc-msg-1b', 'hi penny'));
    await tick();
    const before = t.messaging.texts.length;
    const res = await post(event('spc-msg-1c', 'what can you do?'));
    expect(res.status).toBe(200);
    await tick();
    expect(t.messaging.texts.length).toBeGreaterThan(before);
    expect(t.messaging.texts.at(-1)?.text).not.toContain('/setup#code=');
  });

  test('duplicate delivery (same webhook id + message id) is processed once', async () => {
    const before = t.messaging.texts.length;
    const body = event('spc-msg-dup', 'hello');
    expect((await post(body)).status).toBe(200);
    const again = await post(body);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ duplicate: true });
    await tick();
    expect(t.messaging.texts.length).toBe(before + 1);
  });

  test('bad signature -> 401; stale timestamp -> 400; missing headers -> 400', async () => {
    const body = event('spc-msg-2', 'x');
    expect((await post(body, { sig: `v0=${'0'.repeat(64)}` })).status).toBe(401);
    expect((await post(body, { ts: Math.floor(Date.now() / 1000) - 301 })).status).toBe(400);
    const res = await t.engine.app.request('/v1/photon/webhook', { method: 'POST', body });
    expect(res.status).toBe(400);
  });

  test('signature is over raw bytes: re-serialised JSON fails', async () => {
    const body = event('spc-msg-3', 'x');
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = signSpectrum(WEBHOOK_SECRET, ts, body);
    const reserialised = JSON.stringify(JSON.parse(body), null, 1);
    expect((await post(reserialised, { ts: Number(ts), sig })).status).toBe(401);
  });

  test('unknown event types are acknowledged and ignored; unknown content types are tolerated', async () => {
    const unknown = JSON.stringify({ event: 'typing', foo: 1 });
    expect((await post(unknown)).status).toBe(200);
    const reaction = JSON.parse(event('spc-msg-r', ''));
    reaction.message.content = {
      type: 'reaction',
      emoji: '❤️',
      target: { id: 'x', platform: 'iMessage', timestamp: 'y' },
    };
    expect((await post(JSON.stringify(reaction))).status).toBe(200);
  });

  test('enrolled user gets a crew reply', async () => {
    const user = await t.engine.repos.users.findOrCreateByHandle('+15550123');
    const keys = deviceKeys();
    const { code } = await t.engine.services.enroll.issue(user.id, '+15550123');
    await t.engine.services.enroll.enroll({
      enrollCode: code,
      publicKeyEd25519: keys.publicKeyB64Url,
    });
    expect((await post(event('spc-msg-4', 'how am i doing', '+15550123'))).status).toBe(200);
    await tick();
    expect(t.messaging.texts.at(-1)?.text).toBe('hey tobi, all good 💸');
  });
});

describe('POST /v1/devices/enroll', () => {
  // Distinct IPs for tests that enroll more than a couple of times: the
  // enroll limiter is 10/min per IP and shared across this file.
  const enroll = (body: unknown, idem = idemKey(), ip?: string) =>
    t.engine.app.request('/v1/devices/enroll', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': idem,
        ...(ip ? { 'x-forwarded-for': ip } : {}),
      },
      body: JSON.stringify(body),
    });

  test('one-time code: works once, creates account with device key, then rejected', async () => {
    const user = await t.engine.repos.users.findOrCreateByHandle('+15550200');
    const { code } = await t.engine.services.enroll.issue(user.id, '+15550200');
    const keys = deviceKeys();
    const res = await enroll({ enrollCode: code, publicKeyEd25519: keys.publicKeyB64Url });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { accountId: string; status: string };
    expect(body.accountId).toMatch(/^p[a-z2-9]{9}\.penny\.near$/);
    expect(body.status).toBe('dry_run');
    expect(t.chain.accounts.get(body.accountId)).toBe(keys.publicKeyB64Url);
    const second = await enroll({
      enrollCode: code,
      publicKeyEd25519: deviceKeys().publicKeyB64Url,
    });
    expect(second.status).toBe(401);
  });

  test('retry after a landed enroll: same key gets the same enrollment, a new key is refused', async () => {
    const user = await t.engine.repos.users.findOrCreateByHandle('+15550202');
    const keys = deviceKeys();
    const first = await t.engine.services.enroll.issue(user.id, '+15550202');
    const res = await enroll({ enrollCode: first.code, publicKeyEd25519: keys.publicKeyB64Url });
    expect(res.status).toBe(201);
    type EnrollOk = { userId: string; accountId: string; deviceId: string; status: string };
    const body = (await res.json()) as EnrollOk;

    // the response never reached the phone; Penny texts a fresh code
    const second = await t.engine.services.enroll.issue(user.id, '+15550202');
    const retry = await enroll({ enrollCode: second.code, publicKeyEd25519: keys.publicKeyB64Url });
    expect(retry.status).toBe(201);
    const retryBody = (await retry.json()) as EnrollOk;
    // same enrollment, and the dry-run marker survives the retry
    expect(retryBody).toEqual({ ...body, userId: user.id });
    expect(retryBody.status).toBe('dry_run');

    // a different key is still a second device
    const third = await t.engine.services.enroll.issue(user.id, '+15550202');
    const other = await enroll({
      enrollCode: third.code,
      publicKeyEd25519: deviceKeys().publicKeyB64Url,
    });
    expect(other.status).toBe(409);
  });

  test('a retry that encodes the same key differently is the same key', async () => {
    const user = await t.engine.repos.users.findOrCreateByHandle('+15550203');
    const keys = deviceKeys();
    const first = await t.engine.services.enroll.issue(user.id, '+15550203');
    const res = await enroll(
      { enrollCode: first.code, publicKeyEd25519: keys.publicKeyB64Url },
      idemKey(),
      '198.51.100.31',
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { accountId: string };

    // Same 32 bytes, different (nonzero) pad bits in the last base64url char.
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const last = keys.publicKeyB64Url.at(-1) as string;
    const variant = `${keys.publicKeyB64Url.slice(0, -1)}${alphabet[alphabet.indexOf(last) ^ 1]}`;
    expect(variant).not.toBe(keys.publicKeyB64Url);
    expect(Buffer.from(variant, 'base64url')).toEqual(
      Buffer.from(keys.publicKeyB64Url, 'base64url'),
    );

    const second = await t.engine.services.enroll.issue(user.id, '+15550203');
    const retry = await enroll(
      { enrollCode: second.code, publicKeyEd25519: variant },
      idemKey(),
      '198.51.100.31',
    );
    expect(retry.status).toBe(201);
    expect(((await retry.json()) as { accountId: string }).accountId).toBe(body.accountId);
  });

  test('incomplete enroll (device landed, account did not) is completed by a retry', async () => {
    const user = await t.engine.repos.users.findOrCreateByHandle('+15550204');
    const keys = deviceKeys();
    // The orphaned state older two-step enrolls could leave: active device, no account.
    const device = await t.engine.repos.users.addDevice(user.id, keys.publicKeyB64Url);
    const { code } = await t.engine.services.enroll.issue(user.id, '+15550204');
    const res = await enroll(
      { enrollCode: code, publicKeyEd25519: keys.publicKeyB64Url },
      idemKey(),
      '198.51.100.32',
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      accountId: string;
      deviceId: string;
      status: string;
    };
    expect(body.deviceId).toBe(device.id);
    expect(body.accountId).toMatch(/^p[a-z2-9]{9}\.penny\.near$/);
    const stored = await t.engine.repos.users.byId(user.id);
    expect(stored?.accountId).toBe(body.accountId);
  });

  test('a revoked key gets key_revoked and the code stays usable', async () => {
    const user = await t.engine.repos.users.findOrCreateByHandle('+15550205');
    const keys = deviceKeys();
    const first = await t.engine.services.enroll.issue(user.id, '+15550205');
    const res = await enroll(
      { enrollCode: first.code, publicKeyEd25519: keys.publicKeyB64Url },
      idemKey(),
      '198.51.100.33',
    );
    const body = (await res.json()) as { deviceId: string };
    await t.engine.repos.users.revokeDevice(body.deviceId);

    const { code } = await t.engine.services.enroll.issue(user.id, '+15550205');
    const denied = await enroll(
      { enrollCode: code, publicKeyEd25519: keys.publicKeyB64Url },
      idemKey(),
      '198.51.100.33',
    );
    expect(denied.status).toBe(409);
    expect(await denied.json()).toEqual({ error: 'key_revoked' });

    // the same code still works after the app rotates to a new key
    const rotated = await enroll(
      { enrollCode: code, publicKeyEd25519: deviceKeys().publicKeyB64Url },
      idemKey(),
      '198.51.100.33',
    );
    expect(rotated.status).toBe(201);
  });

  test('expired code rejected (10 min TTL); codes are stored hashed', async () => {
    const user = await t.engine.repos.users.findOrCreateByHandle('+15550201');
    const { code } = await t.engine.services.enroll.issue(user.id, '+15550201');
    const rows = await t.db.db.execute(sql`select code_hash from enroll_codes`);
    expect(JSON.stringify(rows)).not.toContain(code);
    const saved = t.clock.now;
    t.clock.now = new Date(saved.getTime() + 10 * 60_000 + 1);
    const res = await enroll({ enrollCode: code, publicKeyEd25519: deviceKeys().publicKeyB64Url });
    t.clock.now = saved;
    expect(res.status).toBe(401);
  });

  test('bad body shapes -> 400', async () => {
    expect((await enroll({ enrollCode: 'short', publicKeyEd25519: 'x' })).status).toBe(400);
    expect(
      (
        await enroll({
          enrollCode: 'ABCD2345',
          publicKeyEd25519: deviceKeys().publicKeyB64Url,
          extra: 1,
        })
      ).status,
    ).toBe(400);
  });

  test('brute force is rate limited per IP', async () => {
    let limited = false;
    for (let i = 0; i < 15; i++) {
      const res = await t.engine.app.request('/v1/devices/enroll', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': idemKey(),
          'x-forwarded-for': '203.0.113.9',
        },
        body: JSON.stringify({
          enrollCode: 'ABCD2345',
          publicKeyEd25519: deviceKeys().publicKeyB64Url,
        }),
      });
      if (res.status === 429) limited = true;
    }
    expect(limited).toBe(true);
  });
});

describe('security middleware', () => {
  test('secure headers + request id on every response', async () => {
    const res = await t.engine.app.request('/healthz');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('strict-transport-security')).toContain('max-age');
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });
  test('oversized body -> 413', async () => {
    const res = await t.engine.app.request('/v1/photon/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(70_000) },
      body: 'x'.repeat(70_000),
    });
    expect(res.status).toBe(413);
  });
  test('unknown routes 404 as JSON, no stack', async () => {
    const res = await t.engine.app.request('/v1/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });
});
