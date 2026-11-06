import { describe, expect, test } from 'bun:test';
import { createHash, sign as cryptoSign, generateKeyPairSync } from 'node:crypto';
import {
  aaguidEnvironment,
  cborDecode,
  verifyAssertion,
  verifyAttestation,
} from '../src/devices/appattest.ts';

// --- tiny CBOR encoder for fixtures ---
type V = unknown;
function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) + n]);
  if (n < 256) return Buffer.from([(major << 5) + 24, n]);
  return Buffer.from([(major << 5) + 25, n >> 8, n & 0xff]);
}
function enc(v: V): Buffer {
  if (typeof v === 'number') {
    if (v < 0) return Buffer.from([0x20 + (-1 - v)]);
    if (v < 24) return Buffer.from([v]);
    if (v < 256) return Buffer.from([0x18, v]);
    throw new Error('num');
  }
  if (typeof v === 'string') {
    const b = Buffer.from(v);
    return Buffer.concat([head(3, b.length), b]);
  }
  if (v instanceof Uint8Array)
    return Buffer.concat([head(2, v.length), Buffer.from(v.buffer, v.byteOffset, v.length)]);
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map((x) => enc(x))]);
  if (v instanceof Map) {
    const parts = [head(5, v.size)];
    for (const [k, val] of v) parts.push(enc(k), enc(val));
    return Buffer.concat(parts);
  }
  throw new Error('enc');
}

describe('cborDecode', () => {
  test('round-trips maps, bytes, negative ints', () => {
    const m = new Map<unknown, unknown>([
      ['fmt', 'apple-appattest'],
      [-2, new Uint8Array([1, 2])],
    ]);
    const out = cborDecode(new Uint8Array(enc(m))) as Map<unknown, unknown>;
    expect(out.get('fmt')).toBe('apple-appattest');
    expect(Array.from(out.get(-2) as Uint8Array)).toEqual([1, 2]);
    expect(cborDecode(new Uint8Array([0x20]))).toBe(-1);
  });
  test('rejects trailing bytes', () => {
    expect(() => cborDecode(new Uint8Array([0x01, 0x01]))).toThrow();
  });
});

describe('verifyAssertion', () => {
  const appId = 'TEAMID.app.penny.host';
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const xy = Buffer.concat([
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from(jwk.y, 'base64url'),
  ]).toString('base64url');
  const message = 'penny-history:v1:tobi.penny.near:1700000000';
  const clientDataHash = createHash('sha256').update(message).digest();

  function assertion(counter: number, hash = clientDataHash) {
    const rpId = createHash('sha256').update(appId).digest();
    const authData = Buffer.concat([rpId, Buffer.from([0x01]), Buffer.alloc(4)]);
    authData.writeUInt32BE(counter, 33);
    const sig = cryptoSign('sha256', Buffer.concat([authData, hash]), {
      key: privateKey,
      dsaEncoding: 'der',
    });
    const obj = new Map<unknown, unknown>([
      ['authenticatorData', new Uint8Array(authData)],
      ['signature', new Uint8Array(sig)],
    ]);
    return enc(obj).toString('base64url');
  }

  test('accepts a fresh assertion, rejects replay and wrong message', () => {
    const a1 = assertion(1);
    expect(
      verifyAssertion({ assertionB64: a1, publicKeyXY: xy, clientDataHash, appId, lastCounter: 0 }),
    ).toEqual({ counter: 1 });
    expect(() =>
      verifyAssertion({ assertionB64: a1, publicKeyXY: xy, clientDataHash, appId, lastCounter: 1 }),
    ).toThrow();
    const other = createHash('sha256').update('other').digest();
    expect(() =>
      verifyAssertion({
        assertionB64: a1,
        publicKeyXY: xy,
        clientDataHash: other,
        appId,
        lastCounter: 0,
      }),
    ).toThrow();
  });
});

describe('verifyAttestation rejection paths', () => {
  test('rejects non-Apple fmt and broken chains', () => {
    const obj = new Map<unknown, unknown>([
      ['fmt', 'packed'],
      ['authData', new Uint8Array(64)],
      ['attStmt', new Map()],
    ]);
    expect(() =>
      verifyAttestation({
        attestationB64: enc(obj).toString('base64url'),
        challenge: new Uint8Array(32),
        appId: 'T.app',
      }),
    ).toThrow();
    const obj2 = new Map<unknown, unknown>([
      ['fmt', 'apple-appattest'],
      ['authData', new Uint8Array(64)],
      ['attStmt', new Map<unknown, unknown>([['x5c', [new Uint8Array([1]), new Uint8Array([2])]]])],
    ]);
    expect(() =>
      verifyAttestation({
        attestationB64: enc(obj2).toString('base64url'),
        challenge: new Uint8Array(32),
        appId: 'T.app',
      }),
    ).toThrow();
  });
});

describe('AAGUID environment', () => {
  const txt = (s: string) => new TextEncoder().encode(s);
  test('production is "appattest" + seven zero bytes', () => {
    const prod = new Uint8Array(16);
    prod.set(txt('appattest'));
    expect(aaguidEnvironment(prod)).toBe('production');
  });
  test('development is "appattestdevelop", not production', () => {
    expect(aaguidEnvironment(txt('appattestdevelop'))).toBe('development');
  });
  test('anything else is rejected', () => {
    const junk = new Uint8Array(16);
    junk.set(txt('appattest'));
    junk[15] = 1;
    expect(aaguidEnvironment(junk)).toBeNull();
    expect(aaguidEnvironment(txt('appattestdev'))).toBeNull();
    expect(aaguidEnvironment(new Uint8Array(16))).toBeNull();
  });
});
