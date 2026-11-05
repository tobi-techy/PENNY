import { randomUUID } from 'node:crypto';

/**
 * Optional Langfuse tracing via its public ingestion API
 * (POST {base}/api/public/ingestion, basic auth pk:sk). No-op without keys.
 * Only metadata goes out: bot slug, tool names, latency. Never message text.
 */
export interface Tracer {
  trace(name: string, meta: Record<string, string | number | boolean>): void;
}

export const noopTracer: Tracer = { trace: () => {} };

export class LangfuseTracer implements Tracer {
  constructor(
    private readonly baseUrl: string,
    private readonly publicKey: string,
    private readonly secretKey: string,
  ) {}

  trace(name: string, meta: Record<string, string | number | boolean>): void {
    const auth = Buffer.from(`${this.publicKey}:${this.secretKey}`).toString('base64');
    const now = new Date().toISOString();
    void fetch(`${this.baseUrl.replace(/\/$/, '')}/api/public/ingestion`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Basic ${auth}` },
      body: JSON.stringify({
        batch: [
          {
            id: randomUUID(),
            type: 'trace-create',
            timestamp: now,
            body: { id: randomUUID(), name, metadata: meta, timestamp: now },
          },
        ],
      }),
      signal: AbortSignal.timeout(5_000),
    }).catch(() => {});
  }
}
