import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CanonicalJsonError, canonicalize } from '../src/util/canonical.ts';

const VEC_DIR = join(import.meta.dir, '../../shared/test-vectors');

describe('canonical JSON (RFC 8785)', () => {
  test('sorts keys, no whitespace', () => {
    expect(canonicalize({ b: 1, a: [true, null, 'x'] })).toBe('{"a":[true,null,"x"],"b":1}');
  });
  test('rejects undefined, bigint, non-finite, lone surrogate', () => {
    expect(() => canonicalize({ a: undefined })).toThrow(CanonicalJsonError);
    expect(() => canonicalize(1n)).toThrow(CanonicalJsonError);
    expect(() => canonicalize(Number.NaN)).toThrow(CanonicalJsonError);
    expect(() => canonicalize('\uD800')).toThrow(CanonicalJsonError);
  });
  test('matches packages/shared test vectors (drift guard)', () => {
    if (!existsSync(VEC_DIR)) return;
    let n = 0;
    for (const f of readdirSync(VEC_DIR).filter((x) => x.endsWith('.json'))) {
      const v = JSON.parse(readFileSync(join(VEC_DIR, f), 'utf8')) as {
        input?: unknown;
        canonical?: string;
        error?: unknown;
        shouldFail?: boolean;
      };
      if (typeof v.input !== 'string' || typeof v.canonical !== 'string') continue;
      expect(canonicalize(JSON.parse(v.input))).toBe(v.canonical);
      n++;
    }
    expect(n).toBeGreaterThan(0);
  });
});
