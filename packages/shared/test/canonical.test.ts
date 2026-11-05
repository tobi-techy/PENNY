import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import referenceCanonicalize from 'canonicalize';
import { CanonicalJsonError, canonicalize, planHash, sha256Base64Url } from '../src/index.ts';

type Vector = {
  description: string;
  input: string;
  canonical?: string;
  sha256Base64Url?: string;
  expectError?: boolean;
};

const dir = join(import.meta.dir, '..', 'test-vectors');
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .sort();

describe('RFC 8785 test vectors', () => {
  test('there are at least 6 vectors', () => {
    expect(files.length).toBeGreaterThanOrEqual(6);
  });
  for (const f of files) {
    const v = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Vector;
    test(`${f}: ${v.description}`, () => {
      const parsed: unknown = JSON.parse(v.input);
      if (v.expectError) {
        expect(() => canonicalize(parsed)).toThrow(CanonicalJsonError);
        return;
      }
      const out = canonicalize(parsed);
      expect(out).toBe(v.canonical as string);
      expect(sha256Base64Url(out)).toBe(v.sha256Base64Url as string);
      // independent implementation agrees
      expect(referenceCanonicalize(parsed)).toBe(out);
    });
  }
});

describe('canonicalize edge cases', () => {
  test('rejects non-finite numbers', () => {
    expect(() => canonicalize({ a: Number.NaN })).toThrow(CanonicalJsonError);
    expect(() => canonicalize([Number.POSITIVE_INFINITY])).toThrow(CanonicalJsonError);
  });
  test('rejects undefined, bigint, functions, class instances', () => {
    expect(() => canonicalize({ a: undefined })).toThrow(CanonicalJsonError);
    expect(() => canonicalize({ a: 1n })).toThrow(CanonicalJsonError);
    expect(() => canonicalize({ a: () => 1 })).toThrow(CanonicalJsonError);
    expect(() => canonicalize(new Date(0))).toThrow(CanonicalJsonError);
  });
  test('rejects lone surrogates in keys', () => {
    expect(() => canonicalize({ '\uDC00': 1 })).toThrow(CanonicalJsonError);
  });
  test('rejects excessive nesting', () => {
    let deep: unknown = 1;
    for (let i = 0; i < 100; i++) deep = [deep];
    expect(() => canonicalize(deep)).toThrow(CanonicalJsonError);
  });
  test('key order of input does not matter', () => {
    expect(canonicalize({ b: 1, a: { d: 2, c: 3 } })).toBe(
      canonicalize({ a: { c: 3, d: 2 }, b: 1 }),
    );
  });
});

describe('planHash', () => {
  const plan = {
    kind: 'invest',
    fromAsset: 'USDC',
    amountUsd: '50',
    portfolioId: 'eth-momentum',
    quoteId: 'q_123',
  } as const;
  const actions = [
    {
      type: 'FunctionCall',
      methodName: 'ft_transfer_call',
      args: { receiver_id: 'intents.near', amount: '50000000', msg: '{"deposit":"abc"}' },
      gas: '30000000000000',
      deposit: '1',
    },
  ] as const;
  test('matches vector 06', () => {
    const v = JSON.parse(readFileSync(join(dir, '06-plan-hash-invest.json'), 'utf8')) as Vector;
    expect(planHash(plan, [...actions])).toBe(v.sha256Base64Url as string);
  });
  test('is 43 chars base64url and changes when any byte changes', () => {
    const h = planHash(plan, [...actions]);
    expect(h).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(planHash({ ...plan, amountUsd: '50.01' }, [...actions])).not.toBe(h);
    expect(planHash(plan, [{ ...actions[0], deposit: '2' }])).not.toBe(h);
  });
});
