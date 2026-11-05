import { z } from 'zod';
import { type FetchLike, fetchJson } from '../util/http.ts';

/**
 * Glider B2B API v2 client (backend only). Sources:
 *  - OpenAPI: https://api.glider.fi/v2/openapi.json (info.version 2.0.0)
 *  - Quickstart: https://docs.glider.fi/quickstart
 *  - Two-stage enrollment: https://docs.glider.fi/guides/two-stage-enrollment
 *  - Funding: https://docs.glider.fi/guides/portfolio-deposit (no deposit-builder route; fund by on-chain transfer)
 * Auth: `x-api-key` header. Staging: https://staging-api.glider.fi/v2.
 */
export const GLIDER_BASE_URL = 'https://api.glider.fi/v2';
export const GLIDER_STAGING_URL = 'https://staging-api.glider.fi/v2';

const ok = <T extends z.ZodType>(data: T) => z.object({ success: z.literal(true), data });
const page = <T extends z.ZodType>(key: string, item: T) =>
  z.object({
    success: z.literal(true),
    data: z.object({ [key]: z.array(item) }),
    nextCursor: z.string().nullable(),
  });

/** CAIP-10, e.g. eip155:8453:0xabc..., eip155:0:0xabc... (chain-agnostic owner), solana:<ref>:<base58> */
export const Caip10 = z
  .string()
  .regex(/^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}:[-.%a-zA-Z0-9]{1,128}$/);

export const Strategy = z
  .object({
    strategyId: z.string(),
    name: z.string(),
    description: z.string().nullable().optional(),
    allocation: z.unknown(),
    createdAt: z.string(),
  })
  .passthrough();
export const SmartAccount = z
  .object({
    accountId: Caip10,
    depositAccountId: Caip10.optional(),
    swigRoleId: z.number().optional(),
  })
  .passthrough();
export const Portfolio = z
  .object({
    portfolioId: z.string(),
    portfolioName: z.string(),
    ownerAccountId: Caip10,
    strategyId: z.string(),
    smartAccounts: z.array(SmartAccount),
    createdAt: z.string(),
  })
  .passthrough();
export const Positions = z
  .object({
    portfolioId: z.string(),
    totalValueUsd: z.union([z.string(), z.number()]),
    fetchedAt: z.string(),
    assets: z.array(
      z
        .object({
          assetId: z.string(),
          smartAccountId: z.string(),
          symbol: z.string(),
          decimals: z.number(),
          balanceRaw: z.string(),
          valueUsd: z.union([z.string(), z.number()]),
        })
        .passthrough(),
    ),
    warnings: z.array(z.unknown()),
  })
  .passthrough();

export const EnrollMessage = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ecdsa'), raw: z.string() }).passthrough(),
  z.object({ kind: z.literal('typed-data'), typedData: z.unknown() }).passthrough(),
  z.object({ kind: z.literal('solana-message'), text: z.string() }).passthrough(),
]);
export const EnrollStage1 = z
  .object({
    message: EnrollMessage,
    agentAccountId: Caip10,
    accountIndex: z.string().regex(/^\d+$/),
    flowId: z.string(),
    accountType: z.enum(['ECDSA', 'ERC1271']).optional(),
  })
  .passthrough();
export const EnrollStage2 = z
  .object({
    portfolioId: z.string(),
    portfolioName: z.string(),
    strategyId: z.string(),
    smartAccounts: z.array(SmartAccount),
  })
  .passthrough();

export type GliderStrategy = z.infer<typeof Strategy>;
export type GliderPortfolio = z.infer<typeof Portfolio>;
export type EnrollStage1Result = z.infer<typeof EnrollStage1>;

export interface EnrollRequest {
  /** Chain-agnostic EVM owner: `eip155:0:<address>` (docs: do not send a chain-bound owner). */
  ownerAccountId: string;
  strategyId: string;
  chainIds: number[];
  accountType?: 'ECDSA' | 'ERC1271';
}

export interface GliderOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

export class GliderClient {
  private readonly base: string;
  private readonly fetchImpl: FetchLike;
  private readonly apiKey: string;

  constructor(o: GliderOptions) {
    if (typeof (globalThis as { window?: unknown }).window !== 'undefined')
      throw new Error('GliderClient is backend-only');
    if (!o.apiKey) throw new Error('GLIDER_API_KEY required');
    this.apiKey = o.apiKey;
    this.base = o.baseUrl ?? GLIDER_BASE_URL;
    this.fetchImpl = o.fetch ?? ((i, init) => fetch(i, init));
    this.timeoutMs = o.timeoutMs ?? 20_000;
  }
  private readonly timeoutMs: number;

  private req<S extends z.ZodType>(
    path: string,
    schema: S,
    init: { method?: 'GET' | 'POST'; body?: unknown } = {},
  ) {
    return fetchJson(this.fetchImpl, `${this.base}${path}`, schema, {
      method: init.method ?? 'GET',
      body: init.body,
      headers: { 'x-api-key': this.apiKey },
      timeoutMs: this.timeoutMs,
    });
  }

  /** Never serialise the key. */
  toJSON() {
    return { base: this.base };
  }

  whoami() {
    return this.req(
      '/whoami',
      ok(
        z
          .object({ tenantName: z.string().optional(), scopes: z.array(z.string()).optional() })
          .passthrough(),
      ),
    );
  }

  async listStrategies(opts: { limit?: number; cursor?: string } = {}) {
    const q = new URLSearchParams();
    if (opts.limit) q.set('limit', String(opts.limit));
    if (opts.cursor) q.set('cursor', opts.cursor);
    const r = await this.req(`/strategies?${q}`, page('strategies', Strategy));
    return { strategies: r.data.strategies as GliderStrategy[], nextCursor: r.nextCursor };
  }

  async discoverStrategies(
    opts: { collection?: string; sort?: string; limit?: number; cursor?: string } = {},
  ) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(opts)) if (v !== undefined) q.set(k, String(v));
    const r = await this.req(`/discovery/strategies?${q}`, page('strategies', Strategy));
    return { strategies: r.data.strategies as GliderStrategy[], nextCursor: r.nextCursor };
  }

  async listPortfolios(
    opts: { ownerAccountId?: string; strategyId?: string; limit?: number; cursor?: string } = {},
  ) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(opts)) if (v !== undefined) q.set(k, String(v));
    const r = await this.req(`/portfolios?${q}`, page('portfolios', Portfolio));
    return { portfolios: r.data.portfolios as GliderPortfolio[], nextCursor: r.nextCursor };
  }

  async getPortfolio(portfolioId: string): Promise<GliderPortfolio> {
    return (await this.req(`/portfolios/${encodeURIComponent(portfolioId)}`, ok(Portfolio))).data;
  }

  async getPositions(portfolioId: string) {
    return (
      await this.req(`/portfolios/${encodeURIComponent(portfolioId)}/positions`, ok(Positions))
    ).data;
  }

  /** Stage 1: returns the payload the OWNER must sign. The API key cannot sign for the user. */
  async prepareEnrollment(r: EnrollRequest): Promise<EnrollStage1Result> {
    if (!r.ownerAccountId.startsWith('eip155:0:') && !r.ownerAccountId.startsWith('solana:')) {
      throw new Error('ownerAccountId must be chain-agnostic eip155:0:<addr> (or solana:...)');
    }
    return (await this.req('/enroll/signature', ok(EnrollStage1), { method: 'POST', body: r }))
      .data;
  }

  /** Stage 2: echo every stage-1 round-trip field byte-for-byte, plus the owner's signature. Retry with the SAME flowId. */
  async enroll(
    r: EnrollRequest,
    stage1: EnrollStage1Result,
    signature: string,
    portfolioName?: string,
  ) {
    const body = {
      ownerAccountId: r.ownerAccountId,
      strategyId: r.strategyId,
      chainIds: r.chainIds,
      ...(r.accountType ? { accountType: r.accountType } : {}),
      accountIndex: stage1.accountIndex,
      agentAccountId: stage1.agentAccountId,
      flowId: stage1.flowId,
      signature,
      ...(portfolioName ? { portfolioName } : {}),
    };
    return (await this.req('/enroll', ok(EnrollStage2), { method: 'POST', body })).data;
  }

  async startPortfolio(portfolioId: string) {
    return (
      await this.req(`/portfolios/${encodeURIComponent(portfolioId)}/start`, ok(z.unknown()), {
        method: 'POST',
      })
    ).data;
  }
}

/**
 * Funding is an on-chain transfer to the portfolio's smart account on the asset's chain
 * (prefer depositAccountId). Returns the bare address to use as the 1Click `recipient`.
 */
export function resolveDepositAddress(p: GliderPortfolio, chainId: number): string {
  const want = `eip155:${chainId}:`;
  const sa = p.smartAccounts.find((s) => (s.depositAccountId ?? s.accountId).startsWith(want));
  if (!sa) throw new Error(`portfolio ${p.portfolioId} has no smart account on chain ${chainId}`);
  const id = sa.depositAccountId ?? sa.accountId;
  const addr = id.slice(want.length);
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) throw new Error('bad EVM address in smart account');
  return addr;
}
