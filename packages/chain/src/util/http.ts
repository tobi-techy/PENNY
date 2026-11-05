import type { z } from 'zod';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class HttpError extends Error {
  override name = 'HttpError';
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
  }
}

export class SchemaError extends Error {
  override name = 'SchemaError';
  constructor(
    message: string,
    readonly issues: unknown,
  ) {
    super(message);
  }
}

export interface JsonRequest {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}

/** fetch + timeout + zod parse. Error bodies are truncated and never include request headers. */
export async function fetchJson<S extends z.ZodType>(
  fetchImpl: FetchLike,
  url: string,
  schema: S,
  req: JsonRequest = {},
): Promise<z.infer<S>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), req.timeoutMs ?? 15_000);
  try {
    const headers: Record<string, string> = { accept: 'application/json', ...(req.headers ?? {}) };
    const init: RequestInit = { method: req.method ?? 'GET', headers, signal: ctrl.signal };
    if (req.body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(req.body);
    }
    const res = await fetchImpl(url, init);
    const text = await res.text();
    if (!res.ok)
      throw new HttpError(
        `HTTP ${res.status} from ${new URL(url).host}: ${text.slice(0, 160)}`,
        res.status,
        text.slice(0, 500),
      );
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new SchemaError(`non-JSON response from ${new URL(url).host}`, text.slice(0, 200));
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success)
      throw new SchemaError(
        `unexpected response shape from ${new URL(url).host}`,
        parsed.error.issues,
      );
    return parsed.data;
  } finally {
    clearTimeout(timer);
  }
}
