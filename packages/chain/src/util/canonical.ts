/**
 * RFC 8785 JSON Canonicalization Scheme (JCS), local copy so @penny/chain has
 * no build-time dependency on @penny/shared. test/canonical.test.ts runs the
 * shared test vectors (packages/shared/test-vectors) against this copy so the
 * two can never drift silently.
 */
export class CanonicalJsonError extends Error {
  override name = 'CanonicalJsonError';
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function cmp(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = a.charCodeAt(i) - b.charCodeAt(i);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

function ser(v: unknown, depth: number): string {
  if (depth > 64) throw new CanonicalJsonError('nesting too deep');
  if (v === null) return 'null';
  switch (typeof v) {
    case 'boolean':
      return v ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(v)) throw new CanonicalJsonError('non-finite number');
      return JSON.stringify(v);
    case 'string':
      if (LONE_SURROGATE.test(v)) throw new CanonicalJsonError('lone surrogate');
      return JSON.stringify(v);
    case 'object': {
      if (Array.isArray(v)) return `[${v.map((x) => ser(x, depth + 1)).join(',')}]`;
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) {
        throw new CanonicalJsonError('only plain objects are allowed');
      }
      const obj = v as Record<string, unknown>;
      const keys = Object.keys(obj).sort(cmp);
      const parts: string[] = [];
      for (const k of keys) {
        if (LONE_SURROGATE.test(k)) throw new CanonicalJsonError('lone surrogate in key');
        const val = obj[k];
        if (val === undefined) throw new CanonicalJsonError(`undefined value at key ${k}`);
        parts.push(`${JSON.stringify(k)}:${ser(val, depth + 1)}`);
      }
      return `{${parts.join(',')}}`;
    }
    default:
      throw new CanonicalJsonError(`unsupported type ${typeof v}`);
  }
}

export function canonicalize(value: unknown): string {
  return ser(value, 0);
}

export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalize(value));
}
