import {
  AnyCheckResponseSchema,
  type BadgeCheckResponse,
  BadgeCheckResponseSchema,
  type OwnerCheckResponse,
} from './schemas.ts';
import type { BadgeCheck, ConcordiumNetwork, OwnerVerifyResult, VerifyResult } from './types.ts';
import { verdictOf } from './verdict.ts';

/** True when the registry answered with an owner account's agent list. */
export function isOwnerResponse(value: unknown): value is OwnerCheckResponse {
  if (typeof value !== 'object' || value === null) return false;
  return Array.isArray((value as { agents?: unknown }).agents);
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type ConcordiumClientOptions = {
  baseUrl?: string;
  network?: ConcordiumNetwork;
  fetch?: FetchLike;
  now?: () => number;
  timeoutMs?: number;
  cacheTtlMs?: number;
  retryDelayMs?: number;
};

const DEFAULT_BASE_URL = 'https://agent-registry-mcp.concordium.com';
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_RETRY_DELAY_MS = 250;

export class ConcordiumClientError extends Error {
  readonly code: string;
  readonly status?: number;

  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = 'ConcordiumClientError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Thin, typed client for the public Agent Registry REST endpoints.
 * Read-only. Never holds keys and never signs anything.
 */
export class ConcordiumClient {
  private readonly baseUrl: string;
  private readonly network: ConcordiumNetwork;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly retryDelayMs: number;
  private readonly cache = new Map<string, { expiresAt: number; value: BadgeCheck }>();

  constructor(options: ConcordiumClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.network = options.network ?? 'testnet';
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  }

  async checkBadge(id: string, network: ConcordiumNetwork = this.network): Promise<BadgeCheck> {
    const cacheKey = `${network}:${id}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > this.now()) return cached.value;

    const payload = await this.getJson(
      `/v1/check-badge/${encodeURIComponent(id)}?network=${network}`,
    );
    const parsed = BadgeCheckResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ConcordiumClientError(
        'invalid_response',
        'badge check response did not match the expected shape',
      );
    }
    const check = toBadgeCheck(parsed.data);
    this.cache.set(cacheKey, { expiresAt: this.now() + this.cacheTtlMs, value: check });
    return check;
  }

  async verifyBadge(id: string, network: ConcordiumNetwork = this.network): Promise<VerifyResult> {
    const checkedAt = new Date(this.now()).toISOString();
    try {
      const check = await this.checkBadge(id, network);
      return { verdict: verdictOf(check), badge: id, network, checkedAt, check };
    } catch (error) {
      const clientError = asClientError(error);
      return {
        verdict: clientError.status === 404 ? 'unknown' : 'unavailable',
        badge: id,
        network,
        checkedAt,
        check: emptyCheck(network),
        error: clientError.message,
      };
    }
  }

  /**
   * Check an owner account and every agent under it. The registry answers an
   * account with `{account, agent_count, agents: [...]}`, not a single verdict,
   * so the caller gets one row per agent plus a roll-up count.
   */
  async verifyOwner(
    account: string,
    network: ConcordiumNetwork = this.network,
  ): Promise<OwnerVerifyResult> {
    const checkedAt = new Date(this.now()).toISOString();
    const failed = (error: string, verdict: 'unknown' | 'unavailable'): OwnerVerifyResult => ({
      verdict,
      badge: account,
      account,
      network,
      checkedAt,
      check: emptyCheck(network),
      agents: [],
      validCount: 0,
      invalidCount: 0,
      error,
    });
    try {
      const payload = await this.getJson(
        `/v1/check-badge/${encodeURIComponent(account)}?network=${network}`,
      );
      const parsed = AnyCheckResponseSchema.safeParse(payload);
      if (!parsed.success) {
        throw new ConcordiumClientError(
          'invalid_response',
          'owner check response did not match the expected shape',
        );
      }
      if (!isOwnerResponse(parsed.data)) {
        // An account-shaped query answered with a single badge: honour it.
        const one = toBadgeCheck(parsed.data as BadgeCheckResponse);
        return {
          verdict: verdictOf(one),
          badge: account,
          account,
          network,
          checkedAt,
          check: one,
          agents: [one],
          validCount: one.badgeValid ? 1 : 0,
          invalidCount: one.badgeValid ? 0 : 1,
        };
      }
      const owner = parsed.data;
      const agents = owner.agents.map(toBadgeCheck);
      const validCount = agents.filter((a) => a.badgeValid).length;
      const invalidCount = agents.length - validCount;
      // One bad agent among many is not "verified"; the account is only clean
      // when every agent under it passes.
      const verdict: OwnerVerifyResult['verdict'] =
        agents.length === 0
          ? 'unknown'
          : agents.some((a) => verdictOf(a) === 'revoked')
            ? 'revoked'
            : validCount === agents.length
              ? 'verified'
              : 'invalid';
      return {
        verdict,
        badge: account,
        account,
        network,
        checkedAt,
        check: agents[0] ?? emptyCheck(network),
        agents,
        validCount,
        invalidCount,
      };
    } catch (error) {
      const clientError = asClientError(error);
      return failed(clientError.message, clientError.status === 404 ? 'unknown' : 'unavailable');
    }
  }

  async getBadgeJson(id: string, network: ConcordiumNetwork = this.network): Promise<unknown> {
    return this.getJson(`/v1/get-badge-JSON/${encodeURIComponent(id)}?network=${network}`);
  }

  async verifyAgentCard(id: string, network: ConcordiumNetwork = this.network): Promise<unknown> {
    return this.getJson(`/v1/verify-agent-card/${encodeURIComponent(id)}?network=${network}`);
  }

  private async getJson(path: string): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    let lastError: unknown;

    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(url, {
          headers: { accept: 'application/json' },
          signal: controller.signal,
        });

        if (response.status === 429 && attempt === 0) {
          await sleep(this.retryDelay(response.headers.get('retry-after')));
          continue;
        }

        if (!response.ok) {
          throw new ConcordiumClientError(
            `http_${response.status}`,
            `registry returned HTTP ${response.status}`,
            response.status,
          );
        }

        const text = await response.text();
        try {
          return JSON.parse(text) as unknown;
        } catch {
          throw new ConcordiumClientError(
            'invalid_json',
            'registry returned a non-JSON body',
            response.status,
          );
        }
      } catch (error) {
        lastError = error;
        if (attempt === 0 && isRetryable(error)) {
          await sleep(this.retryDelayMs);
          continue;
        }
        throw asClientError(error);
      } finally {
        clearTimeout(timer);
      }
    }

    throw asClientError(lastError);
  }

  private retryDelay(retryAfter: string | null): number {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 2_000);
    return this.retryDelayMs;
  }
}

function toBadgeCheck(response: BadgeCheckResponse): BadgeCheck {
  const onChain = response.on_chain;
  const tokenId = response.token_id == null ? null : Number(response.token_id);
  return {
    tokenId: tokenId != null && Number.isFinite(tokenId) ? tokenId : null,
    tokenAddress: response.token_address ?? null,
    agentUri: response.agent_uri ?? null,
    ownerAccount: onChain?.owner_account ?? null,
    status: onChain?.status ?? null,
    badgeValid: response.badge_valid,
    checks: response.checks,
    issues: response.issues,
    network: response.network,
    raw: response,
  };
}

function emptyCheck(network: ConcordiumNetwork): BadgeCheck {
  return {
    tokenId: null,
    tokenAddress: null,
    agentUri: null,
    ownerAccount: null,
    status: null,
    badgeValid: false,
    checks: {},
    issues: [],
    network,
    raw: null,
  };
}

function asClientError(error: unknown): ConcordiumClientError {
  if (error instanceof ConcordiumClientError) return error;
  if (error instanceof Error) return new ConcordiumClientError('network_error', error.message);
  return new ConcordiumClientError('network_error', 'registry request failed');
}

function isRetryable(error: unknown): boolean {
  if (error instanceof ConcordiumClientError) {
    return error.status == null || error.status >= 500;
  }
  if (error instanceof Error) return error.name === 'AbortError' || error.name === 'TypeError';
  return true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
