/**
 * A software WebAuthn authenticator for tests: real P-256 keys, real CBOR, real
 * signatures, so the engine's server-side checks run against genuine assertions.
 */
import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from 'node:crypto';

type Cbor = number | string | Uint8Array | Cbor[] | Map<Cbor, Cbor>;

function head(major: number, n: number): number[] {
  if (n < 24) return [(major << 5) | n];
  if (n < 256) return [(major << 5) | 24, n];
  if (n < 65536) return [(major << 5) | 25, n >> 8, n & 255];
  return [(major << 5) | 26, (n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}

export function cbor(v: Cbor): Uint8Array {
  const out: number[] = [];
  const enc = (x: Cbor) => {
    if (typeof x === 'number') {
      if (x >= 0) out.push(...head(0, x));
      else out.push(...head(1, -1 - x));
    } else if (typeof x === 'string') {
      const b = new TextEncoder().encode(x);
      out.push(...head(3, b.length), ...b);
    } else if (x instanceof Uint8Array) {
      out.push(...head(2, x.length), ...x);
    } else if (Array.isArray(x)) {
      out.push(...head(4, x.length));
      for (const i of x) enc(i);
    } else {
      out.push(...head(5, x.size));
      for (const [k, val] of x) {
        enc(k);
        enc(val);
      }
    }
  };
  enc(v);
  return new Uint8Array(out);
}

const b64u = (b: Uint8Array | Buffer) => Buffer.from(b).toString('base64url');
const sha256 = (b: Uint8Array | string) => new Uint8Array(createHash('sha256').update(b).digest());

export type SoftPasskey = {
  credentialId: Uint8Array;
  privateKey: KeyObject;
  cose: Uint8Array;
};

export function makePasskey(): SoftPasskey {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const cose = cbor(
    new Map<Cbor, Cbor>([
      [1, 2], // kty: EC2
      [3, -7], // alg: ES256
      [-1, 1], // crv: P-256
      [-2, new Uint8Array(Buffer.from(jwk.x, 'base64url'))],
      [-3, new Uint8Array(Buffer.from(jwk.y, 'base64url'))],
    ]),
  );
  return { credentialId: new Uint8Array(randomBytes(16)), privateKey, cose };
}

function authData(rpId: string, flags: number, signCount: number, attested?: Uint8Array) {
  const count = Buffer.alloc(4);
  count.writeUInt32BE(signCount);
  return new Uint8Array(
    Buffer.concat([
      Buffer.from(sha256(rpId)),
      Buffer.from([flags]),
      count,
      ...(attested ? [Buffer.from(attested)] : []),
    ]),
  );
}

const UP = 0x01;
const UV = 0x04;
const AT = 0x40;

/** navigator.credentials.create() result (attestation "none"), WebAuthn JSON form. */
export function registration(
  pk: SoftPasskey,
  o: { challenge: string; origin: string; rpId: string },
) {
  const idLen = Buffer.alloc(2);
  idLen.writeUInt16BE(pk.credentialId.length);
  const attested = Buffer.concat([
    Buffer.alloc(16), // aaguid
    idLen,
    Buffer.from(pk.credentialId),
    Buffer.from(pk.cose),
  ]);
  const ad = authData(o.rpId, UP | UV | AT, 0, attested);
  const attestationObject = cbor(
    new Map<Cbor, Cbor>([
      ['fmt', 'none'],
      ['attStmt', new Map()],
      ['authData', ad],
    ]),
  );
  const clientDataJSON = JSON.stringify({
    type: 'webauthn.create',
    challenge: o.challenge,
    origin: o.origin,
    crossOrigin: false,
  });
  return {
    id: b64u(pk.credentialId),
    rawId: b64u(pk.credentialId),
    type: 'public-key' as const,
    response: {
      clientDataJSON: b64u(Buffer.from(clientDataJSON)),
      attestationObject: b64u(attestationObject),
      transports: ['internal'],
    },
    clientExtensionResults: {},
  };
}

/** navigator.credentials.get() result, WebAuthn JSON form. */
export function assertion(
  pk: SoftPasskey,
  o: {
    challenge: string;
    origin: string;
    rpId: string;
    uv?: boolean;
    signCount?: number;
    breakSignature?: boolean;
  },
) {
  const ad = authData(o.rpId, UP | (o.uv === false ? 0 : UV), o.signCount ?? 0);
  const clientDataJSON = Buffer.from(
    JSON.stringify({ type: 'webauthn.get', challenge: o.challenge, origin: o.origin }),
  );
  const sig = sign(
    'sha256',
    Buffer.concat([Buffer.from(ad), Buffer.from(sha256(clientDataJSON))]),
    {
      key: pk.privateKey,
      dsaEncoding: 'der',
    },
  );
  if (o.breakSignature) sig[sig.length - 1] = (sig[sig.length - 1] as number) ^ 0xff;
  return {
    id: b64u(pk.credentialId),
    rawId: b64u(pk.credentialId),
    type: 'public-key' as const,
    response: {
      clientDataJSON: b64u(clientDataJSON),
      authenticatorData: b64u(ad),
      signature: b64u(sig),
    },
    clientExtensionResults: {},
  };
}
