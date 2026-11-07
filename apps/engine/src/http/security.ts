import type { Context, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { requestId } from 'hono/request-id';
import { secureHeaders } from 'hono/secure-headers';
import type { Logger } from '../lib/logger.ts';

export type AppVars = { requestId: string; clientIp: string };

/** Fixed-window limiter. In-memory: fine for one instance; swap for Redis when scaling out. */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns seconds to wait, or 0 if allowed. */
  take(key: string): number {
    const t = this.now();
    const e = this.hits.get(key);
    if (!e || e.resetAt <= t) {
      this.hits.set(key, { count: 1, resetAt: t + this.windowMs });
      if (this.hits.size > 50_000) this.sweep(t);
      return 0;
    }
    e.count += 1;
    return e.count > this.limit ? Math.ceil((e.resetAt - t) / 1000) : 0;
  }

  private sweep(t: number) {
    for (const [k, v] of this.hits) if (v.resetAt <= t) this.hits.delete(k);
  }
}

export function clientIp(c: Context): string {
  // Behind a trusted proxy (Fly/Render/Cloudflare) take the first hop; otherwise "unknown".
  const fwd =
    c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
  return fwd && fwd.length <= 64 ? fwd : 'unknown';
}

export function rateLimit(
  limiter: RateLimiter,
  keyOf: (c: Context) => string | null,
): MiddlewareHandler {
  return async (c, next) => {
    const key = keyOf(c);
    if (key) {
      const wait = limiter.take(key);
      if (wait > 0) {
        c.header('Retry-After', String(wait));
        return c.json({ error: 'rate_limited' }, 429);
      }
    }
    await next();
  };
}

/**
 * CSP for the no-install web pages (/setup, /a/:id). The default `default-src 'none'`
 * blocks the page's own bundle, which left every setup and approval link blank.
 * These pages are same-origin only: their scripts, styles and API calls all come
 * from this host, so 'self' is the whole allowance. Still no inline script, no
 * third-party origin, no framing.
 */
export const WEB_PAGE_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
  "connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; " +
  "frame-ancestors 'none'";

/** True for the two routes that serve the built web app (setup + approval pages). */
export function isWebPagePath(path: string): boolean {
  return path === '/setup' || path.startsWith('/a/');
}

/** Applies the SPA policy to the routes that serve the built web app. */
export function webPageCsp(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    c.header('Content-Security-Policy', WEB_PAGE_CSP);
    // The rest of the strict header set still applies to these pages.
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Cross-Origin-Resource-Policy', 'same-origin');
    c.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  };
}

export function securityMiddleware(opts: { maxBodyBytes: number }): MiddlewareHandler[] {
  const headers = secureHeaders({
    strictTransportSecurity: 'max-age=63072000; includeSubDomains; preload',
    xFrameOptions: 'DENY',
    referrerPolicy: 'no-referrer',
    contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    crossOriginResourcePolicy: 'same-origin',
  });
  // secureHeaders writes its CSP after the handler runs, so a later middleware
  // cannot override it. The no-install pages need their own policy, so they skip
  // this one and get it from webPageCsp() instead.
  const conditionalHeaders: MiddlewareHandler = async (c, next) => {
    if (isWebPagePath(c.req.path)) return next();
    return headers(c, next);
  };
  return [
    requestId({ limitLength: 64 }),
    conditionalHeaders,
    bodyLimit({
      maxSize: opts.maxBodyBytes,
      onError: (c) => c.json({ error: 'payload_too_large' }, 413),
    }),
  ];
}

/** Access log: method, path template-ish, status, ms. Never bodies, never auth headers. */
export function accessLog(log: Logger): MiddlewareHandler {
  return async (c, next) => {
    const t = performance.now();
    await next();
    log.info(
      {
        rid: c.get('requestId'),
        method: c.req.method,
        path: c.req.path.replace(/apr_[0-9A-Z]{26}/g, 'apr_:id'),
        status: c.res.status,
        ms: Math.round(performance.now() - t),
      },
      'http',
    );
  };
}

/** Never leak internals: known errors map to safe JSON; everything else is a 500 with a request id. */
export function errorHandler(log: Logger) {
  return (err: Error, c: Context) => {
    const rid = c.get('requestId') as string | undefined;
    if (err instanceof HTTPException) {
      return c.json(
        { error: err.status === 413 ? 'payload_too_large' : 'bad_request', requestId: rid },
        err.status,
      );
    }
    const coded = err as Error & { status?: number; code?: string };
    if (
      typeof coded.status === 'number' &&
      coded.status >= 400 &&
      coded.status < 600 &&
      coded.code
    ) {
      return c.json({ error: coded.code, requestId: rid }, coded.status as 400);
    }
    log.error({ rid, err: err.name, msg: err.message }, 'unhandled');
    return c.json({ error: 'internal', requestId: rid }, 500);
  };
}
