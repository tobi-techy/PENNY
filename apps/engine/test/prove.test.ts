import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { loadEnv } from '../src/env.ts';
import { deviceKeys, makeEngine, type TestEngine } from './helpers.ts';

const SECRET = 'p'.repeat(40);
let t: TestEngine;
beforeAll(async () => {
  t = await makeEngine({ extra: { proveSecret: SECRET } });
}, 120_000);
afterAll(async () => {
  await t?.db.close();
});

const post = (path: string, body: unknown, secret = SECRET) =>
  t.engine.app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
    body: JSON.stringify(body),
  });

describe('testnet proof routes (bun run prove)', () => {
  test('refused without the secret', async () => {
    const r = await post('/v1/prove/approval', {}, 'wrong'.repeat(8));
    expect(r.status).toBe(401);
  });

  test('a proof approval goes through Guard like any other: over-limit is blocked, no card', async () => {
    const keys = deviceKeys();
    expect(
      (
        await post('/v1/prove/enroll', {
          accountId: 'proof.testnet',
          publicKeyEd25519: keys.publicKeyB64Url,
        })
      ).status,
    ).toBe(200);
    const cards = t.messaging.cards.length;
    const big = (await (
      await post('/v1/prove/approval', {
        accountId: 'proof.testnet',
        plan: { kind: 'send', asset: 'NEAR', amount: '5000', to: 'amara.testnet' },
      })
    ).json()) as { decision: string; approvalId?: string };
    expect(big.decision).toBe('block');
    expect(big.approvalId).toBeUndefined();
    // the only card is the Blocked card
    expect(t.messaging.cards.slice(cards).map((c) => c.card.caption)).toEqual(['Not today']);
  });

  test('the routes do not exist without the secret configured', async () => {
    const t2 = await makeEngine();
    const r = await t2.engine.app.request('/v1/prove/approval', { method: 'POST', body: '{}' });
    expect(r.status).toBe(404);
    await t2.db.close();
  }, 60_000);

  test('the engine refuses to boot with a proof secret on mainnet or off testnet', () => {
    expect(() => loadEnv({ PENNY_PROVE_SECRET: SECRET, NEAR_NETWORK: 'mainnet' })).toThrow(
      /PENNY_PROVE_SECRET/,
    );
    expect(() => loadEnv({ PENNY_PROVE_SECRET: 'short', NEAR_NETWORK: 'testnet' })).toThrow(
      /PENNY_PROVE_SECRET/,
    );
    expect(
      loadEnv({ PENNY_PROVE_SECRET: SECRET, NEAR_NETWORK: 'testnet' }).PENNY_PROVE_SECRET,
    ).toBe(SECRET);
  });

  test('a live engine (Spectrum configured) must have an https PUBLIC_BASE_URL', () => {
    expect(() => loadEnv({ SPECTRUM_PROJECT_ID: 'p' })).toThrow(/PUBLIC_BASE_URL/);
    expect(
      loadEnv({ SPECTRUM_PROJECT_ID: 'p', PUBLIC_BASE_URL: 'https://penny.example' })
        .PUBLIC_BASE_URL,
    ).toBe('https://penny.example');
  });

  test('new env names fill the ones the engine reads', () => {
    const e = loadEnv({
      PUBLIC_BASE_URL: 'https://penny.example',
      SPECTRUM_SECRET: 's',
      APPLE_TEAM_ID: 'TEAM123456',
      PENNY_IMESSAGE_EXT_BUNDLE_ID: 'app.penny.host.messages',
      PENNY_IOS_BUNDLE_ID: 'app.penny.host',
    });
    expect(e.SPECTRUM_PROJECT_SECRET).toBe('s');
    expect(e.IMESSAGE_TEAM_ID).toBe('TEAM123456');
    expect(e.IMESSAGE_EXTENSION_BUNDLE_ID).toBe('app.penny.host.messages');
    expect(e.APP_ATTEST_APP_ID).toBe('TEAM123456.app.penny.host');
  });
});
