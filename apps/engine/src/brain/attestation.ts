import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes, webcrypto } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import {
  getCollateral,
  PHALA_PCCS_URL,
  verify as verifyQuoteWithCollateral,
} from '@phala/dcap-qvl';
import type { Logger } from '../lib/logger.ts';

/**
 * NEAR AI Cloud TEE attestation (docs/TEE.md has the sources).
 *
 * Preflight, per model, cached for a short TTL:
 *   GET {base}/attestation/report?model=M&provider=near&signing_algo=ecdsa&nonce=N  (x-no-aliasing)
 *   - gateway_attestation and every model_attestations[] candidate:
 *       Intel TDX quote verified with dcap-qvl against Intel's root CA (collateral via PCCS),
 *       accepted TCB status, TD not in debug mode,
 *       quote report_data == signer(32, zero padded) || our nonce, echoed request_nonce == nonce,
 *       MRCONFIGID == 01 || sha256(app_compose) || 15 zero bytes, RTMR3 == replayed event log
 *   - every model candidate: model_name == NEARAI_MODEL, NVIDIA GPU evidence nonce == our nonce,
 *       NVIDIA NRAS verdict x-nvidia-overall-att-result == true (JWT checked against NRAS JWKS)
 * Per response (money/mail turns): GET {base}/signature/{chat_id}, EIP-191 signer recovered and
 * matched to the attested model (provider_tee) or gateway (gateway) signer, text bound to
 * sha256(exact request bytes) and sha256(exact response bytes).
 *
 * Only the nonce and model id go to NEAR, only NVIDIA's own evidence goes to NRAS, only the
 * quote's FMSPC goes to the PCCS. No keys or user data leave the engine for verification.
 */

export type AttestationMode = 'off' | 'warn' | 'enforce';

export const PRIVATE_MODE_UNAVAILABLE =
  "private mode is unavailable right now (I couldn't verify the secure enclave), so I won't touch money or mail. try again in a bit.";

export const VERIFIED_LABEL = 'private · verified in TEE';

export const ATTESTATION_LINKS = {
  verifier: 'https://cloud.near.ai/verify',
  docs: 'https://docs.near.ai/cloud/verification',
  nras: 'https://nras.attestation.nvidia.com',
} as const;

export const DEFAULT_ACCEPTED_TCB = ['UpToDate', 'SWHardeningNeeded'] as const;
const NRAS_URL = 'https://nras.attestation.nvidia.com/v3/attest/gpu';
const NRAS_JWKS_URL = 'https://nras.attestation.nvidia.com/.well-known/jwks.json';

export class AttestationError extends Error {
  override name = 'AttestationError';
  constructor(
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

// ---------- types ----------

export type Signer = { signingAddress: string; signingAlgo: string };

export type NearReport = {
  intel_quote: string;
  event_log: unknown;
  request_nonce?: string;
  report_data?: string;
  signing_address: string;
  signing_algo: string;
  model_name?: string;
  nvidia_payload?: string;
  info: { tcb_info: unknown };
};

export type VerifiedTd = {
  status: string;
  advisoryIds: string[];
  reportData: Uint8Array;
  mrConfigId: Uint8Array;
  rtMr3: Uint8Array;
  tdAttributes: Uint8Array;
};

/** Verifies an Intel TDX quote's signature chain and returns its TCB status and TD fields. */
export type QuoteVerifier = (quote: Uint8Array) => Promise<VerifiedTd>;

export type AttestationStatus = {
  mode: AttestationMode;
  model: string;
  verified: boolean;
  checkedAt: string | null;
  /** first 16 hex of sha256 over the raw report bytes */
  reportHash: string | null;
  tcbStatus: string | null;
  gateway: Signer | null;
  modelSigners: Signer[];
  gpus: number;
  error: string | null;
  label: string;
  links: typeof ATTESTATION_LINKS;
};

// ---------- helpers ----------

const hex = (s: string): Uint8Array => {
  const h = s.replace(/^0x/i, '');
  if (h.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(h)) throw new AttestationError('bad_hex');
  return new Uint8Array(Buffer.from(h, 'hex'));
};
const eq = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));
const sha256 = (...parts: (Uint8Array | string)[]) => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
};
const sha384 = (...parts: (Uint8Array | string)[]) => {
  const h = createHash('sha384');
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
};
const asJson = (v: unknown): unknown => (typeof v === 'string' ? JSON.parse(v) : v);
export const sha256Hex = (bytes: Uint8Array | string) => Buffer.from(sha256(bytes)).toString('hex');

export function newNonce(): string {
  return randomBytes(32).toString('hex');
}

/** RTMR3 replay as documented in docs.near.ai quote-nonce-signer#replay-the-rtmr3-event-log. */
export function replayRtmr3(eventLog: unknown): Uint8Array {
  const events = asJson(eventLog);
  if (!Array.isArray(events)) throw new AttestationError('event_log_invalid');
  let rtmr3: Uint8Array = new Uint8Array(48);
  for (const e of events as {
    imr: number;
    event_type: number;
    event?: string;
    event_payload?: string;
    digest?: string;
  }[]) {
    if (e.imr !== 3) continue;
    const t = Buffer.alloc(4);
    t.writeUInt32LE(e.event_type >>> 0);
    const digest = sha384(
      t,
      ':',
      Buffer.from(e.event ?? '', 'utf8'),
      ':',
      hex(e.event_payload ?? ''),
    );
    if (e.digest && !eq(hex(e.digest), digest)) throw new AttestationError('event_digest_mismatch');
    rtmr3 = sha384(rtmr3, digest);
  }
  return rtmr3;
}

function signerIdentity(r: { signing_address: string; signing_algo: string }): Uint8Array {
  const id = hex(r.signing_address);
  const want = ({ ecdsa: 20, ed25519: 32 } as Record<string, number>)[r.signing_algo];
  if (want !== id.length) throw new AttestationError('unsupported_signer');
  return id;
}

/** Default quote verifier: dcap-qvl with collateral from Phala's PCCS, Intel root CA. */
export function dcapQuoteVerifier(pccsUrl: string = PHALA_PCCS_URL): QuoteVerifier {
  return async (quote) => {
    const collateral = await getCollateral(pccsUrl, Buffer.from(quote));
    return verifiedTdFrom(verifyQuoteWithCollateral(Buffer.from(quote), collateral, nowSecs()));
  };
}
const nowSecs = () => Math.floor(Date.now() / 1000);

/** Map a dcap-qvl VerifiedReport to the fields we check. Rejects anything that is not TDX. */
export function verifiedTdFrom(v: {
  status: string;
  advisory_ids?: string[];
  report: { asTd10(): TdFields | null };
}): VerifiedTd {
  const td = v.report.asTd10();
  if (!td) throw new AttestationError('not_tdx_quote');
  return {
    status: v.status,
    advisoryIds: v.advisory_ids ?? [],
    reportData: td.reportData,
    mrConfigId: td.mrConfigId,
    rtMr3: td.rtMr3,
    tdAttributes: td.tdAttributes,
  };
}
type TdFields = {
  reportData: Uint8Array;
  mrConfigId: Uint8Array;
  rtMr3: Uint8Array;
  tdAttributes: Uint8Array;
};

/**
 * Verify one NEAR-operated dstack report (gateway or model candidate) against our nonce.
 * docs.near.ai/cloud/verification/reference/quote-nonce-signer
 */
export async function verifyNearReport(
  report: NearReport,
  nonceHex: string,
  quoteVerifier: QuoteVerifier,
  acceptedTcb: readonly string[] = DEFAULT_ACCEPTED_TCB,
): Promise<{ tcbStatus: string; signer: Signer }> {
  if (!report || typeof report.intel_quote !== 'string')
    throw new AttestationError('quote_missing');
  if ((report.request_nonce ?? '').toLowerCase() !== nonceHex.toLowerCase())
    throw new AttestationError('nonce_mismatch');
  let td: VerifiedTd;
  try {
    td = await quoteVerifier(hex(report.intel_quote));
  } catch (e) {
    if (e instanceof AttestationError) throw e;
    throw new AttestationError('quote_invalid', (e as Error).message);
  }
  if (!acceptedTcb.includes(td.status))
    throw new AttestationError('tcb_status_rejected', td.status);
  if (((td.tdAttributes[0] ?? 0) & 1) !== 0) throw new AttestationError('td_debug_mode');

  const id = signerIdentity(report);
  const bound = new Uint8Array(32);
  bound.set(id);
  const expected = new Uint8Array(64);
  expected.set(bound, 0);
  expected.set(hex(nonceHex), 32);
  if (!eq(td.reportData, expected)) throw new AttestationError('report_data_mismatch');
  if (report.report_data && !eq(hex(report.report_data), td.reportData))
    throw new AttestationError('report_data_mismatch');

  const tcb = asJson(report.info?.tcb_info) as { app_compose?: unknown } | undefined;
  if (typeof tcb?.app_compose !== 'string') throw new AttestationError('app_compose_missing');
  const cfg = new Uint8Array(48);
  cfg[0] = 1;
  cfg.set(sha256(Buffer.from(tcb.app_compose, 'utf8')), 1);
  if (!eq(td.mrConfigId, cfg)) throw new AttestationError('mrconfig_mismatch');

  if (!eq(replayRtmr3(report.event_log), td.rtMr3)) throw new AttestationError('rtmr3_mismatch');
  return {
    tcbStatus: td.status,
    signer: {
      signingAddress: report.signing_address.toLowerCase(),
      signingAlgo: report.signing_algo,
    },
  };
}

// ---------- NVIDIA ----------

type Jwk = { kid?: string; kty: string; crv?: string; x?: string; y?: string };

function b64urlJson(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
}

/** Verify an NRAS ES384 JWT signature against NVIDIA's published JWKS. */
export async function verifyNrasJwt(
  token: string,
  jwks: { keys: Jwk[] },
  nowSec: number,
): Promise<Record<string, unknown>> {
  const [h, p, s] = token.split('.');
  if (!h || !p || !s) throw new AttestationError('gpu_jwt_malformed');
  const header = b64urlJson(h);
  if (header.alg !== 'ES384') throw new AttestationError('gpu_jwt_alg');
  const jwk = jwks.keys.find((k) => k.kid === header.kid);
  if (jwk === undefined) throw new AttestationError('gpu_jwt_unknown_kid');
  if (jwk.kty !== 'EC' || jwk.crv !== 'P-384') throw new AttestationError('gpu_jwt_unknown_kid');
  const key = await webcrypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-384', x: jwk.x, y: jwk.y, ext: true },
    { name: 'ECDSA', namedCurve: 'P-384' },
    false,
    ['verify'],
  );
  const ok = await webcrypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-384' },
    key,
    Buffer.from(s, 'base64url'),
    Buffer.from(`${h}.${p}`, 'utf8'),
  );
  if (!ok) throw new AttestationError('gpu_jwt_signature');
  const claims = b64urlJson(p);
  if (claims.iss !== 'https://nras.attestation.nvidia.com')
    throw new AttestationError('gpu_jwt_iss');
  const exp = Number(claims.exp);
  const nbf = Number(claims.nbf ?? 0);
  if (!Number.isFinite(exp) || nowSec > exp + 60 || nowSec + 60 < nbf)
    throw new AttestationError('gpu_jwt_expired');
  return claims;
}

/**
 * docs.near.ai quote-nonce-signer#verify-gpu-evidence-when-present: payload nonce must be ours,
 * send the decoded payload unchanged to NRAS, require x-nvidia-overall-att-result === true.
 */
export async function verifyGpuEvidence(
  nvidiaPayload: string | undefined,
  nonceHex: string,
  http: typeof fetch,
  nowSec: number,
): Promise<number> {
  if (typeof nvidiaPayload !== 'string' || !nvidiaPayload)
    throw new AttestationError('gpu_missing');
  let payload: { nonce?: unknown; evidence_list?: unknown[] };
  try {
    payload = JSON.parse(nvidiaPayload);
  } catch {
    throw new AttestationError('gpu_payload_invalid');
  }
  if (typeof payload.nonce !== 'string' || payload.nonce.toLowerCase() !== nonceHex.toLowerCase())
    throw new AttestationError('gpu_nonce_mismatch');
  const res = await http(NRAS_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: nvidiaPayload,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new AttestationError('gpu_nras_http', String(res.status));
  const out = (await res.json()) as unknown;
  const first = Array.isArray(out) ? (out[0] as unknown) : null;
  if (!Array.isArray(first) || first[0] !== 'JWT' || typeof first[1] !== 'string')
    throw new AttestationError('gpu_nras_shape');
  const jwksRes = await http(NRAS_JWKS_URL, { signal: AbortSignal.timeout(15_000) });
  if (!jwksRes.ok) throw new AttestationError('gpu_jwks_http');
  const claims = await verifyNrasJwt(first[1], (await jwksRes.json()) as { keys: Jwk[] }, nowSec);
  if (claims['x-nvidia-overall-att-result'] !== true)
    throw new AttestationError('gpu_attestation_failed');
  if (String(claims.eat_nonce ?? '').toLowerCase() !== nonceHex.toLowerCase())
    throw new AttestationError('gpu_nonce_mismatch');
  return Array.isArray(payload.evidence_list) ? payload.evidence_list.length : 0;
}

// ---------- response signatures ----------

/** EIP-191 personal_sign signer recovery (ethers.verifyMessage equivalent). */
export function recoverEip191(text: string, signatureHex: string): string {
  const sig = hex(signatureHex);
  if (sig.length !== 65) throw new AttestationError('signature_malformed');
  const msg = Buffer.from(text, 'utf8');
  const digest = keccak_256(
    Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${msg.length}`, 'utf8'), msg]),
  );
  const v = sig[64] ?? 0;
  const rec = v >= 27 ? v - 27 : v;
  if (rec !== 0 && rec !== 1) throw new AttestationError('signature_malformed');
  const pub = secp256k1.Signature.fromBytes(sig.slice(0, 64), 'compact')
    .addRecoveryBit(rec)
    .recoverPublicKey(digest)
    .toBytes(false);
  return `0x${Buffer.from(keccak_256(pub.slice(1)).slice(-20)).toString('hex')}`;
}

export type SignaturePayload = {
  text?: string;
  signature?: string;
  signing_address?: string;
  signing_algo?: string;
  signature_kind?: string;
  error_code?: string;
};

export type CompletionRecord = { chatId: string; requestSha256: string; responseSha256: string };

/**
 * Check a /v1/signature payload against the exact bytes we sent/received and the preflight
 * evidence. docs.near.ai/cloud/verification/cloud-api/response-signatures
 */
export function checkResponseSignature(
  sig: SignaturePayload,
  rec: CompletionRecord,
  model: string,
  status: Pick<AttestationStatus, 'verified' | 'gateway' | 'modelSigners'>,
): 'provider_tee' | 'gateway' {
  if (!status.verified) throw new AttestationError('preflight_unverified');
  if (sig.error_code) throw new AttestationError('signature_unavailable');
  if (sig.signing_algo !== 'ecdsa') throw new AttestationError('signature_algo');
  if (typeof sig.text !== 'string' || typeof sig.signature !== 'string' || !sig.signing_address)
    throw new AttestationError('signature_malformed');
  let recovered: string;
  try {
    recovered = recoverEip191(sig.text, sig.signature);
  } catch {
    throw new AttestationError('signature_invalid');
  }
  const signer = sig.signing_address.toLowerCase();
  if (recovered !== signer) throw new AttestationError('signature_invalid');
  if (sig.signature_kind === 'provider_tee') {
    if (sig.text !== `${model}:${rec.requestSha256}:${rec.responseSha256}`)
      throw new AttestationError('signature_text_mismatch');
    const matches = status.modelSigners.filter(
      (s) => s.signingAlgo === 'ecdsa' && s.signingAddress === signer,
    );
    if (matches.length !== 1) throw new AttestationError('signature_signer_not_attested');
    return 'provider_tee';
  }
  if (sig.signature_kind === 'gateway') {
    if (sig.text !== `${rec.requestSha256}:${rec.responseSha256}`)
      throw new AttestationError('signature_text_mismatch');
    if (status.gateway?.signingAlgo !== 'ecdsa' || status.gateway.signingAddress !== signer)
      throw new AttestationError('signature_signer_not_attested');
    return 'gateway';
  }
  throw new AttestationError('signature_kind_unknown');
}

// ---------- recorder (exact completion bytes per turn) ----------

type TurnLog = { completions: CompletionRecord[] };

/**
 * Wraps the provider's fetch to hash the exact request/response bytes of each
 * /chat/completions call made inside a turn. Hashes only; nothing is stored or sent.
 */
export class CompletionRecorder {
  private readonly als = new AsyncLocalStorage<TurnLog>();

  constructor(private readonly base: typeof fetch = fetch) {}

  readonly fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const res = await this.base(input, init);
    const log = this.als.getStore();
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!log || !url.endsWith('/chat/completions') || !res.ok) return res;
    if (!(res.headers.get('content-type') ?? '').includes('json')) return res;
    const body = init?.body;
    const reqBytes =
      typeof body === 'string'
        ? Buffer.from(body, 'utf8')
        : body instanceof Uint8Array
          ? body
          : null;
    if (!reqBytes) return res;
    const raw = new Uint8Array(await res.clone().arrayBuffer());
    try {
      const id = (JSON.parse(Buffer.from(raw).toString('utf8')) as { id?: unknown }).id;
      if (typeof id === 'string')
        log.completions.push({
          chatId: id,
          requestSha256: sha256Hex(reqBytes),
          responseSha256: sha256Hex(raw),
        });
    } catch {
      /* not JSON, not signable */
    }
    return res;
  }) as typeof fetch;

  run<T>(fn: () => Promise<T>): Promise<T> {
    return this.als.run({ completions: [] }, fn);
  }

  latest(): CompletionRecord | null {
    const c = this.als.getStore()?.completions;
    return c?.[c.length - 1] ?? null;
  }
}

// ---------- service ----------

export interface PrivacyGate {
  readonly mode: AttestationMode;
  status(): Promise<AttestationStatus>;
  /** cached status without a network call */
  peek(): AttestationStatus;
  runTurn<T>(fn: () => Promise<T>): Promise<T>;
  /** Verify the newest completion of this turn is signed by an attested key. */
  verifyLatestResponse(
    status: AttestationStatus,
  ): Promise<{ ok: boolean; kind?: string; error?: string }>;
}

export type AttestationServiceDeps = {
  mode: AttestationMode;
  baseURL: string;
  apiKey?: string;
  model: string;
  fetch?: typeof fetch;
  quoteVerifier?: QuoteVerifier;
  recorder?: CompletionRecorder;
  ttlMs?: number;
  failTtlMs?: number;
  acceptedTcb?: readonly string[];
  now?: () => Date;
  nonce?: () => string;
  log?: Logger;
  signatureRetries?: number;
  signatureRetryDelayMs?: number;
};

export function unverifiedStatus(
  mode: AttestationMode,
  model: string,
  error: string | null,
): AttestationStatus {
  return {
    mode,
    model,
    verified: false,
    checkedAt: null,
    reportHash: null,
    tcbStatus: null,
    gateway: null,
    modelSigners: [],
    gpus: 0,
    error,
    label: mode === 'off' ? 'private mode off' : 'private mode unverified',
    links: ATTESTATION_LINKS,
  };
}

export class AttestationService implements PrivacyGate {
  readonly mode: AttestationMode;
  private cached: { status: AttestationStatus; until: number } | null = null;
  private inflight: Promise<AttestationStatus> | null = null;
  private readonly sigMemo = new Map<
    string,
    Promise<{ ok: boolean; kind?: string; error?: string }>
  >();
  private readonly http: typeof fetch;
  private readonly now: () => Date;
  readonly recorder: CompletionRecorder;

  constructor(private readonly d: AttestationServiceDeps) {
    this.mode = d.mode;
    this.http = d.fetch ?? fetch;
    this.now = d.now ?? (() => new Date());
    this.recorder = d.recorder ?? new CompletionRecorder(this.http);
  }

  private get base() {
    return this.d.baseURL.replace(/\/$/, '');
  }

  peek(): AttestationStatus {
    return (
      this.cached?.status ??
      unverifiedStatus(this.mode, this.d.model, this.mode === 'off' ? null : 'not_checked')
    );
  }

  async status(): Promise<AttestationStatus> {
    if (this.mode === 'off') return unverifiedStatus('off', this.d.model, null);
    if (this.cached && this.cached.until > this.now().getTime()) return this.cached.status;
    if (!this.inflight) {
      this.inflight = this.check().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  /** One fresh check (fresh nonce), never throws. */
  async check(): Promise<AttestationStatus> {
    const nonce = (this.d.nonce ?? newNonce)();
    let status: AttestationStatus;
    try {
      status = await this.verifyFresh(nonce);
    } catch (e) {
      const code = e instanceof AttestationError ? e.code : 'check_failed';
      this.d.log?.warn({ code, model: this.d.model }, 'nearai attestation failed');
      status = {
        ...unverifiedStatus(this.mode, this.d.model, code),
        checkedAt: this.now().toISOString(),
      };
    }
    const ttl = status.verified ? (this.d.ttlMs ?? 300_000) : (this.d.failTtlMs ?? 30_000);
    this.cached = { status, until: this.now().getTime() + ttl };
    return status;
  }

  private async verifyFresh(nonce: string): Promise<AttestationStatus> {
    const q = new URLSearchParams({
      model: this.d.model,
      provider: 'near',
      signing_algo: 'ecdsa',
      nonce,
    });
    const headers: Record<string, string> = { accept: 'application/json', 'x-no-aliasing': 'true' };
    if (this.d.apiKey) headers.authorization = `Bearer ${this.d.apiKey}`;
    const res = await this.http(`${this.base}/attestation/report?${q}`, {
      headers,
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new AttestationError('report_unavailable', String(res.status));
    const raw = new Uint8Array(await res.arrayBuffer());
    return this.verifyReportBytes(raw, nonce);
  }

  /** Verify raw report bytes for a nonce we generated. Exposed for tests and the live script. */
  async verifyReportBytes(raw: Uint8Array, nonce: string): Promise<AttestationStatus> {
    let body: { gateway_attestation?: NearReport; model_attestations?: NearReport[] };
    try {
      body = JSON.parse(Buffer.from(raw).toString('utf8'));
    } catch {
      throw new AttestationError('report_invalid');
    }
    const qv = this.d.quoteVerifier ?? dcapQuoteVerifier();
    const accepted = this.d.acceptedTcb ?? DEFAULT_ACCEPTED_TCB;
    if (!body.gateway_attestation) throw new AttestationError('gateway_missing');
    const gw = await verifyNearReport(body.gateway_attestation, nonce, qv, accepted);
    const candidates = body.model_attestations ?? [];
    if (!candidates.length) throw new AttestationError('no_model_evidence');
    const modelSigners: Signer[] = [];
    let gpus = 0;
    const statuses = [gw.tcbStatus];
    const nowSec = Math.floor(this.now().getTime() / 1000);
    for (const c of candidates) {
      if (c.model_name !== this.d.model) throw new AttestationError('model_mismatch');
      const m = await verifyNearReport(c, nonce, qv, accepted);
      gpus += await verifyGpuEvidence(c.nvidia_payload, nonce, this.http, nowSec);
      modelSigners.push(m.signer);
      statuses.push(m.tcbStatus);
    }
    return {
      mode: this.mode,
      model: this.d.model,
      verified: true,
      checkedAt: this.now().toISOString(),
      reportHash: sha256Hex(raw).slice(0, 16),
      tcbStatus: statuses.every((s) => s === 'UpToDate') ? 'UpToDate' : statuses.join(','),
      gateway: gw.signer,
      modelSigners,
      gpus,
      error: null,
      label: VERIFIED_LABEL,
      links: ATTESTATION_LINKS,
    };
  }

  runTurn<T>(fn: () => Promise<T>): Promise<T> {
    return this.recorder.run(fn);
  }

  async verifyLatestResponse(
    status: AttestationStatus,
  ): Promise<{ ok: boolean; kind?: string; error?: string }> {
    const rec = this.recorder.latest();
    if (!rec) return { ok: false, error: 'no_completion_recorded' };
    // One signature check per completion: tool calls from the same step share it.
    const key = `${rec.chatId}:${rec.responseSha256}:${status.checkedAt}`;
    let p = this.sigMemo.get(key);
    if (!p) {
      p = this.verifyCompletion(rec, status);
      this.sigMemo.set(key, p);
      if (this.sigMemo.size > 200) {
        const first = this.sigMemo.keys().next().value;
        if (first !== undefined) this.sigMemo.delete(first);
      }
    }
    return p;
  }

  async verifyCompletion(
    rec: CompletionRecord,
    status: AttestationStatus,
  ): Promise<{ ok: boolean; kind?: string; error?: string }> {
    if (!status.verified) return { ok: false, error: 'preflight_unverified' };
    if (!this.d.apiKey) return { ok: false, error: 'signature_needs_api_key' };
    const tries = (this.d.signatureRetries ?? 3) + 1;
    for (let i = 0; i < tries; i++) {
      try {
        const q = new URLSearchParams({ model: this.d.model, signing_algo: 'ecdsa' });
        const res = await this.http(
          `${this.base}/signature/${encodeURIComponent(rec.chatId)}?${q}`,
          {
            headers: { accept: 'application/json', authorization: `Bearer ${this.d.apiKey}` },
            signal: AbortSignal.timeout(15_000),
          },
        );
        if (res.status === 404 && i < tries - 1) {
          await Bun.sleep(this.d.signatureRetryDelayMs ?? 500);
          continue;
        }
        if (!res.ok) return { ok: false, error: `signature_http_${res.status}` };
        const kind = checkResponseSignature(
          (await res.json()) as SignaturePayload,
          rec,
          this.d.model,
          status,
        );
        return { ok: true, kind };
      } catch (e) {
        return {
          ok: false,
          error: e instanceof AttestationError ? e.code : 'signature_check_failed',
        };
      }
    }
    return { ok: false, error: 'signature_unavailable' };
  }
}
