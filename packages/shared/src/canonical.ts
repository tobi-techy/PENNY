/**
 * RFC 8785 JSON Canonicalization Scheme (JCS).
 *
 * - Object keys sorted by UTF-16 code units (JS default string comparison).
 * - Strings serialized with ECMAScript JSON.stringify escaping.
 * - Numbers serialized with ECMAScript Number.prototype.toString (via JSON.stringify).
 * - No whitespace.
 * - Rejects input that is not I-JSON: non-finite numbers, lone surrogates,
 *   undefined, functions, symbols, bigint.
 *
 * Swift (ios/) implements the same algorithm and must pass the same
 * vectors in packages/shared/test-vectors/*.json.
 */

export class CanonicalJsonError extends Error {
  override name = 'CanonicalJsonError';
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function serializeString(s: string): string {
  if (LONE_SURROGATE.test(s)) {
    throw new CanonicalJsonError('string contains a lone surrogate (not I-JSON)');
  }
  return JSON.stringify(s);
}

function serializeNumber(n: number): string {
  if (!Number.isFinite(n)) {
    throw new CanonicalJsonError('non-finite numbers are not allowed');
  }
  // JSON.stringify(-0) === "0", which is what JCS requires.
  return JSON.stringify(n);
}

function compareUtf16(a: string, b: string): number {
  // Explicit code-unit compare so behaviour never depends on locale.
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const d = a.charCodeAt(i) - b.charCodeAt(i);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

function serialize(value: unknown, depth: number): string {
  if (depth > 64) throw new CanonicalJsonError('nesting too deep');
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return serializeNumber(value);
    case 'string':
      return serializeString(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((v) => serialize(v, depth + 1)).join(',')}]`;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new CanonicalJsonError('only plain objects can be canonicalized');
      }
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).sort(compareUtf16);
      const parts: string[] = [];
      for (const k of keys) {
        const v = obj[k];
        if (v === undefined) {
          throw new CanonicalJsonError(`undefined value at key "${k}"`);
        }
        parts.push(`${serializeString(k)}:${serialize(v, depth + 1)}`);
      }
      return `{${parts.join(',')}}`;
    }
    default:
      throw new CanonicalJsonError(`cannot canonicalize ${typeof value}`);
  }
}

/** RFC 8785 canonical JSON string. */
export function canonicalize(value: unknown): string {
  return serialize(value, 0);
}

/** Canonical JSON as UTF-8 bytes. */
export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalize(value));
}
