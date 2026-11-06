import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { type Collateral, verify } from '@phala/dcap-qvl';
import {
  AttestationService,
  type AttestationStatus,
  CompletionRecorder,
  checkResponseSignature,
  PRIVATE_MODE_UNAVAILABLE,
  type PrivacyGate,
  type QuoteVerifier,
  recoverEip191,
  replayRtmr3,
  sha256Hex,
  unverifiedStatus,
  VERIFIED_LABEL,
  verifiedTdFrom,
  verifyNrasJwt,
} from '../src/brain/attestation.ts';
import { enrolledUser, makeEngine, scriptedModel } from './helpers.ts';

// Real NEAR AI Cloud report recorded by scripts/nearai-attestation-live.ts --record
// (raw bytes, our nonce, the PCCS collateral and NVIDIA NRAS replies at that moment).
const FX = join(import.meta.dir, 'fixtures', 'nearai-attestation');
const reportRaw = new Uint8Array(readFileSync(join(FX, 'report.json')));
const meta = JSON.parse(readFileSync(join(FX, 'meta.json'), 'utf8')) as {
  recordedAtUnix: number;
  model: string;
  nonce: string;
  reportSha256: string;
};
const collateral = JSON.parse(readFileSync(join(FX, 'collateral.json'), 'utf8')) as Record<
  string,
  Collateral
>;
const nras = JSON.parse(readFileSync(join(FX, 'nras.json'), 'utf8')) as string[];
const jwksText = readFileSync(join(FX, 'nras-jwks.json'), 'utf8');
const recordedAt = new Date(meta.recordedAtUnix * 1000);

const replayQuotes: QuoteVerifier = async (quote) => {
  const c = collateral[sha256Hex(quote)];
  if (!c) throw new Error('no recorded collateral for this quote');
  return verifiedTdFrom(verify(Buffer.from(quote), c, meta.recordedAtUnix));
};

type Calls = { url: string; init?: RequestInit }[];
function replayFetch(body: Uint8Array = reportRaw, nrasReplies: string[] = nras) {
  const calls: Calls = [];
  let gpu = 0;
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, ...(init ? { init } : {}) });
    if (url.includes('/attestation/report'))
      return new Response(body, { headers: { 'content-type': 'application/json' } });
    if (url.includes('/attest/gpu')) return new Response(nrasReplies[gpu++] ?? '[]');
    if (url.includes('jwks')) return new Response(jwksText);
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return { f, calls };
}

function service(over: Partial<ConstructorParameters<typeof AttestationService>[0]> = {}) {
  const { f, calls } = replayFetch();
  const svc = new AttestationService({
    mode: 'enforce',
    baseURL: 'https://cloud-api.near.ai/v1',
    model: meta.model,
    fetch: f,
    quoteVerifier: replayQuotes,
    nonce: () => meta.nonce,
    now: () => recordedAt,
    ...over,
  });
  return { svc, calls };
}

const report = () => JSON.parse(Buffer.from(reportRaw).toString('utf8'));
const bytes = (o: unknown) => new Uint8Array(Buffer.from(JSON.stringify(o), 'utf8'));

describe('NEAR AI attestation: real recorded report', () => {
  test('full verification passes (gateway + model TDX quotes, nonce, RTMR3, MRCONFIGID, 8 GPUs via NRAS)', async () => {
    const { svc, calls } = service();
    const s = await svc.check();
    expect(s.error).toBeNull();
    expect(s.verified).toBe(true);
    expect(s.model).toBe('z-ai/glm-5.3-flash');
    expect(s.reportHash).toBe(meta.reportSha256.slice(0, 16));
    expect(s.tcbStatus).toBe('UpToDate');
    expect(s.gpus).toBe(8);
    expect(s.modelSigners).toHaveLength(1);
    expect(s.gateway?.signingAlgo).toBe('ecdsa');
    expect(s.label).toBe(VERIFIED_LABEL);
    const req = new URL(calls[0]?.url ?? '');
    expect(req.searchParams.get('nonce')).toBe(meta.nonce);
    expect(req.searchParams.get('model')).toBe(meta.model);
    expect(req.searchParams.get('provider')).toBe('near');
    // nothing but NVIDIA's own evidence goes to NRAS, and no API key anywhere when none is set
    for (const c of calls) {
      expect(new Headers(c.init?.headers).get('authorization')).toBeNull();
      if (c.url.includes('/attest/gpu'))
        expect(c.init?.body).toBe(report().model_attestations[0].nvidia_payload);
    }
  });

  test('tampered nonce fails (fresh nonce does not match the recorded report)', async () => {
    const { svc } = service({ nonce: () => 'ab'.repeat(32) });
    const s = await svc.check();
    expect(s.verified).toBe(false);
    expect(s.error).toBe('nonce_mismatch');
  });

  test('echoed nonce rewritten to ours still fails: the quote binds the original nonce', async () => {
    const other = 'cd'.repeat(32);
    const r = report();
    r.gateway_attestation.request_nonce = other;
    r.gateway_attestation.report_data = undefined;
    await expect(
      service({ nonce: () => other }).svc.verifyReportBytes(bytes(r), other),
    ).rejects.toMatchObject({ code: 'report_data_mismatch' });
  });

  test('wrong model fails', async () => {
    const { svc } = service({ model: 'deepseek-ai/DeepSeek-V3.1' });
    const s = await svc.check();
    expect(s.verified).toBe(false);
    expect(s.error).toBe('model_mismatch');
  });

  test('tampered app_compose fails MRCONFIGID', async () => {
    const r = report();
    const tcb =
      typeof r.model_attestations[0].info.tcb_info === 'string'
        ? JSON.parse(r.model_attestations[0].info.tcb_info)
        : r.model_attestations[0].info.tcb_info;
    tcb.app_compose = `${tcb.app_compose} `;
    r.model_attestations[0].info.tcb_info = tcb;
    await expect(service().svc.verifyReportBytes(bytes(r), meta.nonce)).rejects.toMatchObject({
      code: 'mrconfig_mismatch',
    });
  });

  test('tampered event log fails RTMR3', async () => {
    const r = report();
    const log = JSON.parse(r.gateway_attestation.event_log);
    const ev = log.find((e: { imr: number }) => e.imr === 3);
    ev.event_payload = `${ev.event_payload}00`;
    ev.digest = '';
    r.gateway_attestation.event_log = JSON.stringify(log);
    await expect(service().svc.verifyReportBytes(bytes(r), meta.nonce)).rejects.toMatchObject({
      code: 'rtmr3_mismatch',
    });
    expect(replayRtmr3(report().gateway_attestation.event_log)).toHaveLength(48);
  });

  test('a flipped byte in the TDX quote fails quote verification', async () => {
    const r = report();
    const q: string = r.model_attestations[0].intel_quote;
    // flip one byte of the TD report body (inside the signed region)
    const i = 48 * 2 + 200;
    r.model_attestations[0].intel_quote =
      q.slice(0, i) + (q[i] === '0' ? '1' : '0') + q.slice(i + 1);
    const verifier: QuoteVerifier = async (quote) =>
      verifiedTdFrom(
        verify(
          Buffer.from(quote),
          collateral[sha256Hex(Buffer.from(q, 'hex'))] as Collateral,
          meta.recordedAtUnix,
        ),
      );
    await expect(
      service({ quoteVerifier: verifier }).svc.verifyReportBytes(bytes(r), meta.nonce),
    ).rejects.toMatchObject({ code: 'quote_invalid' });
  });

  test('missing GPU evidence and GPU nonce mismatch fail', async () => {
    const r = report();
    delete r.model_attestations[0].nvidia_payload;
    await expect(service().svc.verifyReportBytes(bytes(r), meta.nonce)).rejects.toMatchObject({
      code: 'gpu_missing',
    });
    const r2 = report();
    const p = JSON.parse(r2.model_attestations[0].nvidia_payload);
    p.nonce = 'ef'.repeat(32);
    r2.model_attestations[0].nvidia_payload = JSON.stringify(p);
    await expect(service().svc.verifyReportBytes(bytes(r2), meta.nonce)).rejects.toMatchObject({
      code: 'gpu_nonce_mismatch',
    });
  });

  test('NRAS JWT: real token verifies against NVIDIA JWKS, a forged claim does not', async () => {
    const token = (JSON.parse(nras[0] ?? '[]') as [string, string][])[0]?.[1] ?? '';
    const claims = await verifyNrasJwt(token, JSON.parse(jwksText), meta.recordedAtUnix);
    expect(claims['x-nvidia-overall-att-result']).toBe(true);
    expect(claims.eat_nonce).toBe(meta.nonce);
    const [h, p, s] = token.split('.');
    const forged = JSON.parse(Buffer.from(p ?? '', 'base64url').toString('utf8'));
    forged.eat_nonce = 'ef'.repeat(32);
    const bad = `${h}.${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${s}`;
    await expect(
      verifyNrasJwt(bad, JSON.parse(jwksText), meta.recordedAtUnix),
    ).rejects.toMatchObject({
      code: 'gpu_jwt_signature',
    });
    await expect(
      verifyNrasJwt(token, JSON.parse(jwksText), meta.recordedAtUnix + 86_400),
    ).rejects.toMatchObject({ code: 'gpu_jwt_expired' });
  });

  test('status is cached per model for the TTL, then re-checked with a new nonce', async () => {
    let clock = recordedAt.getTime();
    const nonces: string[] = [];
    const { svc, calls } = service({
      now: () => new Date(clock),
      ttlMs: 60_000,
      nonce: () => {
        nonces.push(meta.nonce);
        return meta.nonce;
      },
    });
    const [a, b] = await Promise.all([svc.status(), svc.status()]);
    expect(a.verified && b.verified).toBe(true);
    await svc.status();
    expect(calls.filter((c) => c.url.includes('/attestation/report'))).toHaveLength(1);
    clock += 61_000;
    await svc.status();
    expect(nonces).toHaveLength(2);
  });

  test('mode off never touches the network', async () => {
    const { svc, calls } = service({ mode: 'off' });
    const s = await svc.status();
    expect(s.mode).toBe('off');
    expect(s.verified).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test('unreachable report endpoint is unverified, not a crash', async () => {
    const svc = new AttestationService({
      mode: 'warn',
      baseURL: 'https://cloud-api.near.ai/v1',
      model: meta.model,
      fetch: (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch,
      quoteVerifier: replayQuotes,
    });
    const s = await svc.status();
    expect(s.verified).toBe(false);
    expect(s.error).toBe('report_unavailable');
  });
});

// ---- per-response signatures ----

function eip191Sign(text: string, priv: Uint8Array): string {
  const msg = Buffer.from(text, 'utf8');
  const digest = keccak_256(
    Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${msg.length}`), msg]),
  );
  const sig = secp256k1.Signature.fromBytes(
    secp256k1.sign(digest, priv, { prehash: false, format: 'recovered' }),
    'recovered',
  );
  return `0x${Buffer.from(sig.toBytes('compact')).toString('hex')}${(27 + (sig.recovery ?? 0)).toString(16)}`;
}
function addressOf(priv: Uint8Array) {
  const pub = secp256k1.getPublicKey(priv, false);
  return `0x${Buffer.from(keccak_256(pub.slice(1)).slice(-20)).toString('hex')}`;
}

describe('response signatures', () => {
  const priv = secp256k1.utils.randomSecretKey();
  const addr = addressOf(priv);
  const rec = {
    chatId: 'chatcmpl-1',
    requestSha256: 'a'.repeat(64),
    responseSha256: 'b'.repeat(64),
  };
  const model = meta.model;
  const status: Pick<AttestationStatus, 'verified' | 'gateway' | 'modelSigners'> = {
    verified: true,
    gateway: { signingAddress: '0x0000000000000000000000000000000000000001', signingAlgo: 'ecdsa' },
    modelSigners: [{ signingAddress: addr, signingAlgo: 'ecdsa' }],
  };
  const text = `${model}:${rec.requestSha256}:${rec.responseSha256}`;
  const good = {
    text,
    signature: eip191Sign(text, priv),
    signing_address: addr,
    signing_algo: 'ecdsa',
    signature_kind: 'provider_tee',
  };

  test('EIP-191 recovery matches the signer', () => {
    expect(recoverEip191(text, good.signature)).toBe(addr);
  });
  test('provider_tee signature bound to exact bytes and the attested model key passes', () => {
    expect(checkResponseSignature(good, rec, model, status)).toBe('provider_tee');
  });
  test('bad signature fails', () => {
    const sig = good.signature;
    const flipped = `${sig.slice(0, 10)}${sig[10] === 'a' ? 'b' : 'a'}${sig.slice(11)}`;
    expect(() =>
      checkResponseSignature({ ...good, signature: flipped }, rec, model, status),
    ).toThrow();
  });
  test('signature over other bytes fails', () => {
    expect(() =>
      checkResponseSignature(good, { ...rec, responseSha256: 'c'.repeat(64) }, model, status),
    ).toThrow('signature_text_mismatch');
  });
  test('wrong model in signed text fails', () => {
    expect(() => checkResponseSignature(good, rec, 'other/model', status)).toThrow(
      'signature_text_mismatch',
    );
  });
  test('valid signature from a key that is not the attested one fails', () => {
    const realSigners = JSON.parse(Buffer.from(reportRaw).toString('utf8')).model_attestations.map(
      (m: { signing_address: string }) => ({
        signingAddress: m.signing_address.toLowerCase(),
        signingAlgo: 'ecdsa',
      }),
    );
    expect(() =>
      checkResponseSignature(good, rec, model, { ...status, modelSigners: realSigners }),
    ).toThrow('signature_signer_not_attested');
  });
  test('unverified preflight and unavailable signatures fail', () => {
    expect(() => checkResponseSignature(good, rec, model, { ...status, verified: false })).toThrow(
      'preflight_unverified',
    );
    expect(() => checkResponseSignature({ error_code: 'x' }, rec, model, status)).toThrow(
      'signature_unavailable',
    );
  });
  test('service fetches /v1/signature with the key and verifies; no key = unverified', async () => {
    const { f } = replayFetch();
    const sigFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/signature/chatcmpl-1')) return new Response(JSON.stringify(good));
      return f(input, init);
    }) as typeof fetch;
    const full = { ...unverifiedStatus('enforce', model, null), ...status } as AttestationStatus;
    const svc = new AttestationService({
      mode: 'enforce',
      baseURL: 'https://cloud-api.near.ai/v1',
      apiKey: 'test-key',
      model,
      fetch: sigFetch,
    });
    expect(await svc.verifyCompletion(rec, full)).toEqual({ ok: true, kind: 'provider_tee' });
    const noKey = new AttestationService({ mode: 'enforce', baseURL: 'x', model, fetch: sigFetch });
    expect((await noKey.verifyCompletion(rec, full)).error).toBe('signature_needs_api_key');
  });
});

describe('completion recorder', () => {
  test('hashes exact request and response bytes of /chat/completions inside a turn only', async () => {
    const respBody = '{"id":"chatcmpl-xyz","choices":[]}';
    const base = (async () =>
      new Response(respBody, {
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    const r = new CompletionRecorder(base);
    const reqBody = '{"model":"m","messages":[]}';
    await r.fetch('https://x/v1/chat/completions', { method: 'POST', body: reqBody });
    expect(r.latest()).toBeNull();
    await r.run(async () => {
      const res = await r.fetch('https://x/v1/chat/completions', { method: 'POST', body: reqBody });
      expect(await res.text()).toBe(respBody);
      expect(r.latest()).toEqual({
        chatId: 'chatcmpl-xyz',
        requestSha256: sha256Hex(reqBody),
        responseSha256: sha256Hex(respBody),
      });
    });
  });
});

// ---- crew gate ----

function fakeGate(
  mode: 'warn' | 'enforce',
  verified: boolean,
  responseOk = verified,
): PrivacyGate & {
  sigChecks: number;
} {
  const s: AttestationStatus = {
    ...unverifiedStatus(mode, meta.model, verified ? null : 'nonce_mismatch'),
    verified,
    ...(verified ? { label: VERIFIED_LABEL } : {}),
  };
  const g = {
    mode,
    sigChecks: 0,
    status: async () => s,
    peek: () => s,
    runTurn: <T>(fn: () => Promise<T>) => fn(),
    verifyLatestResponse: async () => {
      g.sigChecks += 1;
      return responseOk
        ? { ok: true, kind: 'provider_tee' }
        : { ok: false, error: 'signature_invalid' };
    },
  };
  return g;
}

describe('crew privacy gate', () => {
  const sendSteps = () =>
    scriptedModel([
      { tool: 'propose_send', input: { kind: 'send', asset: 'USDC', amount: '1', to: 'bob.near' } },
      { text: 'card is up, face id to send' },
    ]);
  const router = () => scriptedModel([{ tool: 'route', input: { bot: 'penny', reason: 'money' } }]);

  test('no gate: unchanged (no privacy field)', async () => {
    const t = await makeEngine({ router: router(), chat: sendSteps() });
    const u = await enrolledUser(t);
    const r = await t.engine.services.crew.handle(u.userId, u.space, 'send 1 usdc to bob.near');
    expect(r.privacy).toBeUndefined();
    expect(r.text).toBe('card is up, face id to send');
    await t.db.close();
  }, 60_000);

  test('enforce + failed attestation: money tool refused, reply says private mode unavailable', async () => {
    const t = await makeEngine({
      router: router(),
      chat: sendSteps(),
      privacy: fakeGate('enforce', false),
    });
    const u = await enrolledUser(t);
    const before = t.messaging.cards.length;
    const r = await t.engine.services.crew.handle(u.userId, u.space, 'send 1 usdc to bob.near');
    expect(r.text).toBe(PRIVATE_MODE_UNAVAILABLE);
    expect(r.privacy).toEqual({ verified: false, label: 'private mode unverified', blocked: true });
    expect(t.messaging.cards.length).toBe(before);
    await t.db.close();
  }, 60_000);

  test('enforce + verified report but bad response signature: refused', async () => {
    const gate = fakeGate('enforce', true, false);
    const t = await makeEngine({ router: router(), chat: sendSteps(), privacy: gate });
    const u = await enrolledUser(t);
    const r = await t.engine.services.crew.handle(u.userId, u.space, 'send 1 usdc to bob.near');
    expect(r.text).toBe(PRIVATE_MODE_UNAVAILABLE);
    expect(gate.sigChecks).toBe(1);
    await t.db.close();
  }, 60_000);

  test('enforce + verified + signed: money tool runs and reply is tagged verified', async () => {
    const t = await makeEngine({
      router: router(),
      chat: sendSteps(),
      privacy: fakeGate('enforce', true),
    });
    const u = await enrolledUser(t);
    const before = t.messaging.cards.length;
    const r = await t.engine.services.crew.handle(u.userId, u.space, 'send 1 usdc to bob.near');
    expect(r.text).toBe('card is up, face id to send');
    expect(r.privacy).toEqual({ verified: true, label: VERIFIED_LABEL, blocked: false });
    expect(t.messaging.cards.length).toBe(before + 1);
    await t.db.close();
  }, 60_000);

  test('warn + failed attestation: tool still runs, reply tagged unverified', async () => {
    const t = await makeEngine({
      router: router(),
      chat: sendSteps(),
      privacy: fakeGate('warn', false),
    });
    const u = await enrolledUser(t);
    const r = await t.engine.services.crew.handle(u.userId, u.space, 'send 1 usdc to bob.near');
    expect(r.text).toBe('card is up, face id to send');
    expect(r.privacy?.verified).toBe(false);
    expect(r.privacy?.blocked).toBe(false);
    await t.db.close();
  }, 60_000);

  test('enforce does not touch non-money turns', async () => {
    const t = await makeEngine({
      router: router(),
      chat: scriptedModel([{ text: 'hey!' }]),
      privacy: fakeGate('enforce', false),
    });
    const u = await enrolledUser(t);
    const r = await t.engine.services.crew.handle(u.userId, u.space, 'hi');
    expect(r.text).toBe('hey!');
    expect(r.privacy?.blocked).toBe(false);
    await t.db.close();
  }, 60_000);

  test('GET /v1/attestation reports status; off when no gate', async () => {
    const off = await makeEngine();
    const r0 = await off.engine.app.request('/v1/attestation');
    expect(((await r0.json()) as AttestationStatus).mode).toBe('off');
    await off.db.close();
    const t = await makeEngine({ privacy: fakeGate('enforce', true) });
    const r = await t.engine.app.request('/v1/attestation');
    const j = (await r.json()) as AttestationStatus;
    expect(j.verified).toBe(true);
    expect(j.label).toBe(VERIFIED_LABEL);
    expect(j.links.verifier).toBe('https://cloud.near.ai/verify');
    await t.db.close();
  }, 60_000);
});
