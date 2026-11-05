import { describe, expect, test } from 'bun:test';
import { Writable } from 'node:stream';
import {
  checkCardToken,
  issueCardToken,
  parseCardAuth,
  READ_GRACE_MS,
} from '../src/approvals/card-token.ts';
import {
  assertTransition,
  canTransition,
  isTerminal,
  stepsFor,
  TransitionError,
} from '../src/approvals/state.ts';
import { withMoneyRule } from '../src/brain/bots.ts';
import { fitToColumn } from '../src/brain/memory.ts';
import { EnvError, loadEnv } from '../src/env.ts';
import { RateLimiter } from '../src/http/security.ts';
import { constantTimeEqual, randomCode } from '../src/lib/crypto.ts';
import { createLogger } from '../src/lib/logger.ts';
import { signSpectrum, verifySpectrumSignature } from '../src/photon/verify.ts';

describe('spectrum webhook signature', () => {
  const secret = 'f'.repeat(64);
  const body = '{"event":"messages","x":"é"}';
  const now = 1_747_242_392;
  const ts = String(now);
  test('accepts a correct v0 signature', () => {
    const signature = signSpectrum(secret, ts, body);
    expect(signature).toMatch(/^v0=[0-9a-f]{64}$/);
    expect(
      verifySpectrumSignature({ secret, rawBody: body, timestamp: ts, signature, nowSec: now }).ok,
    ).toBe(true);
  });
  test('matches the documented construction exactly', () => {
    // v0=HMAC_SHA256(secret, "v0:{ts}:{body}") lowercase hex
    const { createHmac } = require('node:crypto') as typeof import('node:crypto');
    const expected = `v0=${createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')}`;
    expect(signSpectrum(secret, ts, body)).toBe(expected);
  });
  test('rejects tampered body, wrong secret, uppercase hex, missing prefix', () => {
    const sig = signSpectrum(secret, ts, body);
    const bad = (signature: string, rawBody = body, s = secret) =>
      verifySpectrumSignature({ secret: s, rawBody, timestamp: ts, signature, nowSec: now });
    expect(bad(sig, `${body} `)).toMatchObject({ ok: false, status: 401 });
    expect(bad(sig, body, 'e'.repeat(64))).toMatchObject({ ok: false, status: 401 });
    expect(bad(`v0=${sig.slice(3).toUpperCase()}`)).toMatchObject({ ok: false, status: 401 });
    expect(bad(sig.slice(3))).toMatchObject({ ok: false, status: 401 });
  });
  test('timestamp tolerance is 5 minutes both ways', () => {
    const at = (offset: number) => {
      const t = String(now + offset);
      return verifySpectrumSignature({
        secret,
        rawBody: body,
        timestamp: t,
        signature: signSpectrum(secret, t, body),
        nowSec: now,
      });
    };
    expect(at(300).ok).toBe(true);
    expect(at(-300).ok).toBe(true);
    expect(at(301)).toMatchObject({ ok: false, status: 400, reason: 'stale_timestamp' });
    expect(at(-301)).toMatchObject({ ok: false, status: 400 });
  });
  test('missing headers and junk timestamps -> 400', () => {
    expect(
      verifySpectrumSignature({ secret, rawBody: body, timestamp: undefined, signature: 'x' }),
    ).toMatchObject({ status: 400 });
    expect(
      verifySpectrumSignature({ secret, rawBody: body, timestamp: ts, signature: undefined }),
    ).toMatchObject({ status: 400 });
    expect(
      verifySpectrumSignature({
        secret,
        rawBody: body,
        timestamp: '1e9',
        signature: 'x',
        nowSec: now,
      }),
    ).toMatchObject({ status: 400 });
  });
});

describe('approval state machine', () => {
  test('legal and illegal transitions', () => {
    expect(canTransition('pending', 'signed')).toBe(true);
    expect(canTransition('pending', 'expired')).toBe(true);
    expect(canTransition('pending', 'cancelled')).toBe(true);
    expect(canTransition('signed', 'relayed')).toBe(true);
    expect(canTransition('relayed', 'settled')).toBe(true);
    expect(canTransition('relayed', 'failed')).toBe(true);
    expect(canTransition('pending', 'settled')).toBe(false);
    expect(canTransition('pending', 'relayed')).toBe(false);
    expect(canTransition('signed', 'settled')).toBe(false); // money can't skip relay
    expect(canTransition('settled', 'failed')).toBe(false);
    expect(canTransition('expired', 'signed')).toBe(false);
    expect(() => assertTransition('cancelled', 'pending')).toThrow(TransitionError);
  });
  test('create_bot: signed -> settled, never relayed', () => {
    expect(canTransition('signed', 'settled', 'create_bot')).toBe(true);
    expect(canTransition('signed', 'relayed', 'create_bot')).toBe(false);
    expect(canTransition('pending', 'settled', 'create_bot')).toBe(false);
  });
  test('terminal states and steps', () => {
    for (const s of ['settled', 'failed', 'expired', 'cancelled'] as const)
      expect(isTerminal(s)).toBe(true);
    expect(isTerminal('pending')).toBe(false);
    expect(stepsFor('signed').map((s) => s.state)).toEqual(['done', 'active', 'todo']);
    expect(stepsFor('settled').every((s) => s.state === 'done')).toBe(true);
    expect(stepsFor('failed')[1]?.state).toBe('failed');
  });
});

describe('cardToken', () => {
  const now = new Date('2026-11-05T19:00:00Z');
  const exp = new Date(now.getTime() + 60_000);
  test('256-bit random, only the hash is stored', () => {
    const a = issueCardToken();
    const b = issueCardToken();
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.hash).not.toContain(a.token);
    expect(a.token).not.toBe(b.token);
  });
  test('checks', () => {
    const { token, hash } = issueCardToken();
    const base = { storedHash: hash, expiresAt: exp, now, mode: 'mutate' as const };
    expect(checkCardToken({ ...base, token })).toBe('ok');
    expect(checkCardToken({ ...base, token: null })).toBe('missing');
    expect(checkCardToken({ ...base, token: issueCardToken().token })).toBe('invalid');
    const later = new Date(exp.getTime() + 1);
    expect(checkCardToken({ ...base, token, now: later })).toBe('expired');
    expect(checkCardToken({ ...base, token, now: later, mode: 'read' })).toBe('ok');
    expect(
      checkCardToken({
        ...base,
        token,
        now: new Date(exp.getTime() + READ_GRACE_MS + 1),
        mode: 'read',
      }),
    ).toBe('expired');
  });
  test('Authorization: Card header parsing is strict', () => {
    const { token } = issueCardToken();
    expect(parseCardAuth(`Card ${token}`)).toBe(token);
    expect(parseCardAuth(`Bearer ${token}`)).toBeNull();
    expect(parseCardAuth(`Card ${token}x`)).toBeNull();
    expect(parseCardAuth(undefined)).toBeNull();
  });
});

describe('env (fails closed)', () => {
  test('dev defaults: DRY_RUN on, relay off', () => {
    const e = loadEnv({});
    expect(e.PENNY_ENV).toBe('dev');
    expect(e.DRY_RUN).toBe('1');
    expect(e.relayLive).toBe(false);
    expect(e.NEARAI_BASE_URL).toBe('https://cloud-api.near.ai/v1');
  });
  test('mainnet without secrets throws and names keys only', () => {
    try {
      loadEnv({ PENNY_ENV: 'mainnet', NEARAI_API_KEY: 'sk-supersecretvalue' });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(EnvError);
      const msg = (e as Error).message;
      expect(msg).toContain('SPECTRUM_WEBHOOK_SECRET');
      expect(msg).toContain('NEAR_RELAYER_PRIVATE_KEY');
      expect(msg).not.toContain('supersecret');
    }
  });
  const full = {
    PENNY_ENV: 'mainnet',
    NEAR_NETWORK: 'mainnet',
    PUBLIC_BASE_URL: 'https://api.penny.money',
    DATABASE_URL: 'postgres://x',
    SPECTRUM_PROJECT_ID: 'p',
    SPECTRUM_PROJECT_SECRET: 's',
    SPECTRUM_WEBHOOK_SECRET: 'w',
    IMESSAGE_TEAM_ID: 't',
    NEARAI_API_KEY: 'k',
    NEAR_RELAYER_ACCOUNT_ID: 'relayer.penny.near',
    NEAR_RELAYER_PRIVATE_KEY: 'ed25519:xxx',
    NEAR_RPC_URL: 'https://rpc.mainnet.near.org',
  };
  test('relay is live only with mainnet AND DRY_RUN=0 AND relayer key', () => {
    expect(loadEnv(full).relayLive).toBe(false); // DRY_RUN defaults to 1
    expect(loadEnv({ ...full, DRY_RUN: '0' }).relayLive).toBe(true);
    expect(() => loadEnv({ ...full, DRY_RUN: '0', NEAR_RELAYER_PRIVATE_KEY: '' })).toThrow(
      EnvError,
    );
    expect(() => loadEnv({ ...full, NEAR_NETWORK: 'testnet' })).toThrow(EnvError);
    expect(() => loadEnv({ ...full, PUBLIC_BASE_URL: 'http://api.penny.money' })).toThrow(EnvError);
    expect(() => loadEnv({ DRY_RUN: 'yes' })).toThrow(EnvError);
  });
});

describe('misc security helpers', () => {
  test('constantTimeEqual', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'abcd')).toBe(false);
  });
  test('randomCode uses only the alphabet', () => {
    const c = randomCode(1000, 'AB2');
    expect(c).toMatch(/^[AB2]{1000}$/);
  });
  test('rate limiter window', () => {
    let t = 0;
    const rl = new RateLimiter(2, 1000, () => t);
    expect(rl.take('k')).toBe(0);
    expect(rl.take('k')).toBe(0);
    expect(rl.take('k')).toBeGreaterThan(0);
    expect(rl.take('other')).toBe(0);
    t = 1001;
    expect(rl.take('k')).toBe(0);
  });
  test('logger redacts secrets', () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _e, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const log = createLogger('info', sink);
    log.info(
      {
        cardToken: 'TOPSECRET1',
        req: { headers: { authorization: 'Card TOPSECRET2' } },
        apiKey: 'TOPSECRET3',
        signedDelegateAction: 'TOPSECRET4',
      },
      'x',
    );
    const out = lines.join('');
    expect(out).not.toContain('TOPSECRET');
    expect(out).toContain('[redacted]');
  });
  test('souls always carry the money rule; embeddings are padded', () => {
    expect(withMoneyRule('# X\nhi')).toContain('Mood never overrides money rules.');
    const s = '# X\nMood never overrides money rules.';
    expect(withMoneyRule(s)).toBe(s);
    expect(fitToColumn([1, 2], 4)).toEqual([1, 2, 0, 0]);
    expect(() => fitToColumn([1, 2, 3], 2)).toThrow();
  });
});

describe('souls/', () => {
  const { readdirSync, readFileSync } = require('node:fs') as typeof import('node:fs');
  const { join } = require('node:path') as typeof import('node:path');
  const dir = join(import.meta.dir, '..', '..', '..', 'souls');
  test('every built-in has a SOUL file that states the money rule', () => {
    const files = readdirSync(dir);
    for (const slug of ['penny', 'invest', 'guard', 'mail', 'finance', 'errand']) {
      expect(files).toContain(`${slug}.md`);
      expect(readFileSync(join(dir, `${slug}.md`), 'utf8')).toContain(
        'Mood never overrides money rules.',
      );
    }
  });
});
