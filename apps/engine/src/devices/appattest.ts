import { createHash, createPublicKey, verify as cryptoVerify, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Apple App Attest verification (attestation + assertion), implemented from
 * Apple's "Validating apps that connect to your server" spec. No blob is
 * trusted without this: certificate chain to the embedded Apple App
 * Attestation Root CA, nonce binding to our server challenge, rpId/app id,
 * credential id == SHA-256 of the credential certificate public key, and a
 * monotonic assertion counter.
 */

export class AttestError extends Error {
  override name = 'AttestError';
  constructor(readonly code: string) {
    super(code);
  }
}

// ---------- minimal CBOR decoder (definite-length, I-JSON subset) ----------
export type CborValue =
  | number
  | bigint
  | string
  | Uint8Array
  | boolean
  | null
  | CborValue[]
  | Map<CborKey, CborValue>;
export type CborKey = string | number;

export function cborDecode(input: Uint8Array): CborValue {
  let i = 0;
  const take = (n: number): Uint8Array => {
    if (i + n > input.length) throw new AttestError('cbor_truncated');
    const out = input.subarray(i, i + n);
    i += n;
    return out;
  };
  const readArg = (ai: number): bigint => {
    if (ai < 24) return BigInt(ai);
    if (ai === 24) return BigInt(take(1).at(0) ?? 0);
    if (ai === 26) return BigInt(readU32());
    if (ai === 27) return readU64();
    throw new AttestError('cbor_indefinite_or_reserved');
  };
  const readU32 = (): number => {
    const b = take(4);
    return new DataView(b.buffer, b.byteOffset).getUint32(0);
  };
  const readU64 = (): bigint => {
    const b = take(8);
    return new DataView(b.buffer, b.byteOffset).getBigUint64(0);
  };
  const decode = (): CborValue => {
    const first = take(1).at(0) ?? 0;
    const major = first >> 5;
    const ai = first & 0x1f;
    switch (major) {
      case 0:
        return Number(readArg(ai));
      case 1: {
        const v = -1n - readArg(ai);
        return v >= -9_007_199_254_740_991n ? Number(v) : v;
      }
      case 2:
        return new Uint8Array(take(Number(readArg(ai))));
      case 3:
        return new TextDecoder().decode(take(Number(readArg(ai))));
      case 4: {
        const n = Number(readArg(ai));
        const arr: CborValue[] = [];
        for (let k = 0; k < n; k++) arr.push(decode());
        return arr;
      }
      case 5: {
        const n = Number(readArg(ai));
        const map = new Map<CborKey, CborValue>();
        for (let k = 0; k < n; k++) {
          const key = decode();
          if (typeof key !== 'string' && typeof key !== 'number') throw new AttestError('cbor_key');
          map.set(key, decode());
        }
        return map;
      }
      case 7: {
        if (ai === 20) return false;
        if (ai === 21) return true;
        if (ai === 22) return null;
        throw new AttestError('cbor_simple_unsupported');
      }
      default:
        throw new AttestError('cbor_tag_unsupported');
    }
  };
  const value = decode();
  if (i !== input.length) throw new AttestError('cbor_trailing');
  return value;
}

function mapGet(map: CborValue, key: CborKey): CborValue {
  if (!(map instanceof Map)) throw new AttestError('cbor_not_map');
  const v = map.get(key);
  if (v === undefined) throw new AttestError(`cbor_missing_${String(key)}`);
  return v;
}
function asBytes(v: CborValue): Uint8Array {
  if (!(v instanceof Uint8Array)) throw new AttestError('cbor_not_bytes');
  return v;
}
function asText(v: CborValue): string {
  if (typeof v !== 'string') throw new AttestError('cbor_not_text');
  return v;
}

// ---------- authData ----------
export type AuthData = {
  rpIdHash: Uint8Array;
  counter: number;
  aaguid: Uint8Array;
  credId: Uint8Array;
  coseX: Uint8Array;
  coseY: Uint8Array;
};

export function parseAuthData(authData: Uint8Array, withCredential: boolean): AuthData {
  if (authData.length < 37) throw new AttestError('authdata_short');
  const rpIdHash = authData.subarray(0, 32);
  const dv = new DataView(authData.buffer, authData.byteOffset);
  const counter = dv.getUint32(33);
  if (!withCredential) {
    return {
      rpIdHash,
      counter,
      aaguid: new Uint8Array(),
      credId: new Uint8Array(),
      coseX: new Uint8Array(),
      coseY: new Uint8Array(),
    };
  }
  const aaguid = authData.subarray(37, 53);
  const credIdLen = dv.getUint16(53);
  const credId = authData.subarray(55, 55 + credIdLen);
  const cose = cborDecode(authData.subarray(55 + credIdLen));
  const x = asBytes(mapGet(cose, -2));
  const y = asBytes(mapGet(cose, -3));
  if (Number(mapGet(cose, 1)) !== 2 || Number(mapGet(cose, 3)) !== -7)
    throw new AttestError('cose_not_es256');
  return {
    rpIdHash,
    counter,
    aaguid,
    credId: new Uint8Array(credId),
    coseX: new Uint8Array(x),
    coseY: new Uint8Array(y),
  };
}

const sha256 = (b: Uint8Array | string): Buffer => createHash('sha256').update(b).digest();
const b64url = (b: Uint8Array): string => Buffer.from(b).toString('base64url');

// The official Apple root (fetched from apple.com/certificateauthority).
const APPLE_ROOT_PEM = readFileSync(join(import.meta.dir, 'apple-app-attest-root.pem'), 'utf8');
export const APPLE_ROOT_SUBJECT = new X509Certificate(APPLE_ROOT_PEM).subject;

const NONCE_OID_DER = Buffer.from([
  0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x63, 0x64, 0x08, 0x02,
]);

function extensionContainsNonce(certDer: Uint8Array, expectedNonce: Buffer): boolean {
  const der = Buffer.from(certDer);
  const idx = der.indexOf(NONCE_OID_DER);
  if (idx < 0) return false;
  // The nonce (32 bytes) lives in the extension value right after the OID.
  return der.subarray(idx, idx + 256).includes(expectedNonce);
}

export type VerifiedAttestation = {
  keyId: string; // base64url credential id
  publicKeyXY: string; // base64url x||y (65? no: 64 bytes)
  environment: 'production' | 'development';
};

/**
 * Apple's App Attest AAGUID is 16 bytes: "appattestdevelop" for development,
 * or "appattest" followed by seven 0x00 bytes for production. Anything else
 * (including a 16-byte value that merely starts with "appattest") is rejected.
 */
export function aaguidEnvironment(aaguid: Uint8Array): 'production' | 'development' | null {
  if (aaguid.length !== 16) return null;
  const head = new TextDecoder().decode(aaguid.subarray(0, 9));
  if (head === 'appattest' && aaguid.subarray(9).every((b) => b === 0)) return 'production';
  if (new TextDecoder().decode(aaguid) === 'appattestdevelop') return 'development';
  return null;
}

export function verifyAttestation(input: {
  attestationB64: string;
  challenge: Uint8Array;
  appId: string; // "TEAMID.bundle.id"
}): VerifiedAttestation {
  const raw = Buffer.from(input.attestationB64, 'base64url');
  const obj = cborDecode(new Uint8Array(raw));
  if (asText(mapGet(obj, 'fmt')) !== 'apple-appattest') throw new AttestError('fmt');
  const authData = asBytes(mapGet(obj, 'authData'));
  const attStmt = mapGet(obj, 'attStmt');
  const x5c = mapGet(attStmt, 'x5c');
  if (!Array.isArray(x5c) || x5c.length < 2) throw new AttestError('x5c');
  const credDer = asBytes(x5c[0] as CborValue);
  const interDer = asBytes(x5c[1] as CborValue);
  const credCert = new X509Certificate(Buffer.from(credDer));
  const interCert = new X509Certificate(Buffer.from(interDer));
  const rootCert = new X509Certificate(APPLE_ROOT_PEM);

  // 1) Chain: cred <- intermediate <- Apple root (signatures + issuers).
  if (!credCert.checkIssued(interCert) || !credCert.verify(interCert.publicKey))
    throw new AttestError('chain_cred');
  if (!interCert.checkIssued(rootCert) || !interCert.verify(rootCert.publicKey))
    throw new AttestError('chain_root');
  if (!rootCert.verify(rootCert.publicKey)) throw new AttestError('chain_root_self');

  // Dates are checked by X509Certificate validity window manually.
  const now = Date.now();
  for (const c of [credCert, interCert]) {
    if (now < Date.parse(c.validFrom) || now > Date.parse(c.validTo))
      throw new AttestError('cert_expired');
  }

  // 2) authData: app id, counter 0, aaguid.
  const auth = parseAuthData(authData, true);
  if (!sha256(input.appId).equals(Buffer.from(auth.rpIdHash))) throw new AttestError('rp_id');
  if (auth.counter !== 0) throw new AttestError('counter_not_zero');
  const environment = aaguidEnvironment(auth.aaguid);
  if (!environment) throw new AttestError('aaguid');

  // 3) Nonce: SHA256(authData || SHA256(challenge)) in the cert extension.
  const clientDataHash = sha256(input.challenge);
  const nonce = sha256(Buffer.concat([Buffer.from(authData), clientDataHash]));
  if (!extensionContainsNonce(credDer, nonce)) throw new AttestError('nonce');

  // 4) Credential id == SHA256 of the credential cert's public key (SPKI).
  const spki = credCert.publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  if (!sha256(spki).equals(Buffer.from(auth.credId))) throw new AttestError('cred_id');

  // 5) COSE key in authData matches the certificate key.
  const jwk = credCert.publicKey.export({ format: 'jwk' }) as { x?: string; y?: string };
  if (!jwk.x || !jwk.y) throw new AttestError('cred_key');
  if (b64url(auth.coseX) !== jwk.x || b64url(auth.coseY) !== jwk.y)
    throw new AttestError('cose_mismatch');

  return {
    keyId: b64url(auth.credId),
    publicKeyXY: b64url(Buffer.concat([Buffer.from(auth.coseX), Buffer.from(auth.coseY)])),
    environment,
  };
}

export function verifyAssertion(input: {
  assertionB64: string;
  publicKeyXY: string; // from attestation
  clientDataHash: Uint8Array; // SHA256 of the signed message
  appId: string;
  lastCounter: number;
}): { counter: number } {
  const obj = cborDecode(new Uint8Array(Buffer.from(input.assertionB64, 'base64url')));
  const signature = asBytes(mapGet(obj, 'signature'));
  const authData = asBytes(mapGet(obj, 'authenticatorData'));
  const auth = parseAuthData(authData, false);
  if (!sha256(input.appId).equals(Buffer.from(auth.rpIdHash))) throw new AttestError('rp_id');
  if (auth.counter <= input.lastCounter) throw new AttestError('counter_replay');
  const xy = Buffer.from(input.publicKeyXY, 'base64url');
  if (xy.length !== 64) throw new AttestError('pubkey');
  const key = createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: b64url(xy.subarray(0, 32)), y: b64url(xy.subarray(32)) },
    format: 'jwk',
  });
  const signed = Buffer.concat([Buffer.from(authData), Buffer.from(input.clientDataHash)]);
  let ok = false;
  try {
    ok = cryptoVerify('sha256', signed, { key, dsaEncoding: 'der' }, Buffer.from(signature));
  } catch {
    ok = false;
  }
  if (!ok) throw new AttestError('signature');
  return { counter: auth.counter };
}
