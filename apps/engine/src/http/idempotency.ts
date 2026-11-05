import type { Context } from 'hono';
import { sha256Hex } from '../lib/crypto.ts';
import type { IdempotencyRepo } from '../repo/infra.ts';

const KEY_RE = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * Idempotency-Key is required on side-effecting POSTs (SECURITY.md).
 * Same key + same body -> stored response. Same key + different body -> 422.
 */
export async function withIdempotency(
  c: Context,
  repo: IdempotencyRepo,
  scope: string,
  rawBody: string,
  run: () => Promise<{ status: number; body: unknown }>,
): Promise<Response> {
  const key = c.req.header('idempotency-key');
  if (!key || !KEY_RE.test(key)) return c.json({ error: 'idempotency_key_required' }, 400);
  const begun = await repo.begin(scope, key, sha256Hex(rawBody));
  if (begun.kind === 'replay') {
    c.header('Idempotent-Replayed', 'true');
    return c.json(begun.body as object, begun.status as 200);
  }
  if (begun.kind === 'conflict') return c.json({ error: 'idempotency_key_reused' }, 422);
  if (begun.kind === 'in_flight') return c.json({ error: 'request_in_progress' }, 409);
  try {
    const r = await run();
    // cache definitive outcomes; 5xx can be retried with the same key
    if (r.status < 500) await repo.finish(scope, key, r.status, r.body);
    else await repo.abandon(scope, key);
    return c.json(r.body as object, r.status as 200);
  } catch (e) {
    await repo.abandon(scope, key);
    throw e;
  }
}
