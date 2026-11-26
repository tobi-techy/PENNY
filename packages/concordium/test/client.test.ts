import { describe, expect, test } from 'bun:test';
import { ConcordiumClient, type FetchLike } from '../src/client.ts';
import type { BadgeCheck } from '../src/types.ts';
import { verdictOf } from '../src/verdict.ts';

const OWNER = '3ewJGpdgo6NcDt36tmhnakMv9YB1qBQNPQBAinEJy9T1dpujfT';
const BADGE = 'JyP9Wd81dn3JwiAs6agks';
const CARD = 'https://example.test/agent-card.json';

const valid = {
  token_id: 1169,
  token_address: BADGE,
  agent_uri: CARD,
  http_status: 200,
  card_sha256: '6f10957ecc9ab4dbbe8e0e85e49a76a0f55fd55ec794210fc9f0593c4633cb67',
  on_chain: {
    owner_account: OWNER,
    status: 'Active',
    agent_uri: CARD,
    metadata_hash_hex: '6f10957ecc9ab4dbbe8e0e85e49a76a0f55fd55ec794210fc9f0593c4633cb67',
  },
  checks: {
    on_chain_agent_found: true,
    status_active: true,
    card_fetched: true,
    hash_matches_on_chain: true,
    owner_matches: true,
    extension_conformant: true,
    verification_present: true,
  },
  badge_valid: true,
  issues: [],
  network: 'testnet',
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function check(overrides: Partial<BadgeCheck> = {}): BadgeCheck {
  return {
    tokenId: 1169,
    tokenAddress: BADGE,
    agentUri: CARD,
    ownerAccount: OWNER,
    status: 'Active',
    badgeValid: true,
    checks: { on_chain_agent_found: true, status_active: true },
    issues: [],
    network: 'testnet',
    raw: null,
    ...overrides,
  };
}

describe('ConcordiumClient.verifyOwner', () => {
  const ownerBody = (validCount: number, total = 2) => ({
    network: 'testnet',
    account: OWNER,
    agent_count: total,
    summary: { valid: validCount, invalid: total - validCount },
    expected: { extension_uri: 'https://docs.concordium.com/a2a-extensions/concordium-badge/v1' },
    agents: Array.from({ length: total }, (_, i) => ({
      ...valid,
      token_id: 1169 + i,
      token_address: `badge${i}`,
      badge_valid: i < validCount,
      issues: i < validCount ? [] : [{ severity: 'error', field: 'card_fetch', message: '404' }],
    })),
  });

  test('parses the account shape the registry really returns', async () => {
    const client = new ConcordiumClient({
      fetch: async () => json(ownerBody(2)),
      now: () => 0,
    });
    const result = await client.verifyOwner(OWNER);

    // Before this, the account shape fell through as invalid_response/unavailable.
    expect(result.error).toBeUndefined();
    expect(result.verdict).toBe('verified');
    expect(result.account).toBe(OWNER);
    expect(result.agents).toHaveLength(2);
    expect(result.validCount).toBe(2);
    expect(result.invalidCount).toBe(0);
    expect(result.agents[0]?.tokenId).toBe(1169);
  });

  test('one bad agent makes the whole account invalid, not verified', async () => {
    const client = new ConcordiumClient({ fetch: async () => json(ownerBody(1, 4)), now: () => 0 });
    const result = await client.verifyOwner(OWNER);

    expect(result.verdict).toBe('invalid');
    expect(result.validCount).toBe(1);
    expect(result.invalidCount).toBe(3);
  });

  test('an account with no agents is unknown, not verified', async () => {
    const client = new ConcordiumClient({ fetch: async () => json(ownerBody(0, 0)), now: () => 0 });
    const result = await client.verifyOwner(OWNER);
    expect(result.verdict).toBe('unknown');
    expect(result.agents).toEqual([]);
  });

  test('revoked anywhere in the account wins over invalid', async () => {
    const body = ownerBody(1, 2);
    const second = body.agents[1];
    if (!second) throw new Error('fixture needs two agents');
    second.on_chain = {
      owner_account: OWNER,
      status: 'Revoked',
      agent_uri: CARD,
      metadata_hash_hex: valid.on_chain.metadata_hash_hex,
    };
    const client = new ConcordiumClient({ fetch: async () => json(body), now: () => 0 });
    const result = await client.verifyOwner(OWNER);
    expect(result.verdict).toBe('revoked');
  });

  test('a single-badge answer to an account query is honoured, not discarded', async () => {
    const client = new ConcordiumClient({ fetch: async () => json(valid), now: () => 0 });
    const result = await client.verifyOwner(OWNER);
    expect(result.verdict).toBe('verified');
    expect(result.agents).toHaveLength(1);
  });

  test('a 404 is unknown, a 500 is unavailable', async () => {
    const missing = new ConcordiumClient({
      fetch: async () => json({ error: 'not_found' }, 404),
      now: () => 0,
      retryDelayMs: 0,
    });
    expect((await missing.verifyOwner(OWNER)).verdict).toBe('unknown');

    const down = new ConcordiumClient({
      fetch: async () => json({ error: 'boom' }, 503),
      now: () => 0,
      retryDelayMs: 0,
    });
    const out = await down.verifyOwner(OWNER);
    expect(out.verdict).toBe('unavailable');
    expect(out.error).toBeTruthy();
  });

  test('a malformed owner body is unavailable, never a silent pass', async () => {
    const client = new ConcordiumClient({
      fetch: async () => json({ agents: 'not an array' }),
      now: () => 0,
    });
    const out = await client.verifyOwner(OWNER);
    expect(out.verdict).toBe('unavailable');
    expect(out.agents).toEqual([]);
  });
});

describe('ConcordiumClient', () => {
  test('maps a valid badge check', async () => {
    const client = new ConcordiumClient({ fetch: async () => json(valid), now: () => 0 });
    const result = await client.checkBadge(BADGE);

    expect(result.tokenId).toBe(1169);
    expect(result.ownerAccount).toBe(OWNER);
    expect(result.status).toBe('Active');
    expect(result.badgeValid).toBe(true);
    expect(result.checks.hash_matches_on_chain).toBe(true);
  });

  test('returns verified for a valid badge', async () => {
    const client = new ConcordiumClient({ fetch: async () => json(valid), now: () => 0 });
    const result = await client.verifyBadge(BADGE);

    expect(result.verdict).toBe('verified');
    expect(result.error).toBeUndefined();
  });

  test('returns invalid when the badge exists but fails a check', async () => {
    const invalid = {
      ...valid,
      badge_valid: false,
      checks: { ...valid.checks, card_fetched: false, hash_matches_on_chain: false },
      issues: [{ severity: 'error', field: 'agent_uri', message: 'no agent_uri set on chain' }],
    };
    const client = new ConcordiumClient({ fetch: async () => json(invalid), now: () => 0 });
    const result = await client.verifyBadge(BADGE);

    expect(result.verdict).toBe('invalid');
  });

  test('returns revoked when the on-chain status is revoked', async () => {
    const revoked = {
      ...valid,
      badge_valid: false,
      on_chain: { ...valid.on_chain, status: 'Revoked' },
      checks: { ...valid.checks, status_active: false },
    };
    const client = new ConcordiumClient({ fetch: async () => json(revoked), now: () => 0 });
    const result = await client.verifyBadge(BADGE);

    expect(result.verdict).toBe('revoked');
  });

  test('returns unknown on a 404', async () => {
    const client = new ConcordiumClient({ fetch: async () => json({}, 404), now: () => 0 });
    const result = await client.verifyBadge(BADGE);

    expect(result.verdict).toBe('unknown');
    expect(result.error).toContain('404');
  });

  test('returns unavailable after a 500 retry', async () => {
    let calls = 0;
    const client = new ConcordiumClient({
      fetch: async () => {
        calls++;
        return json({}, 500);
      },
      now: () => 0,
      retryDelayMs: 1,
    });
    const result = await client.verifyBadge(BADGE);

    expect(result.verdict).toBe('unavailable');
    expect(calls).toBe(2);
  });

  test('retries once on 429 and honors retry-after', async () => {
    let calls = 0;
    const client = new ConcordiumClient({
      fetch: async () => {
        calls++;
        return calls === 1 ? json({}, 429, { 'retry-after': '0' }) : json(valid);
      },
      now: () => 0,
    });
    const result = await client.verifyBadge(BADGE);

    expect(result.verdict).toBe('verified');
    expect(calls).toBe(2);
  });

  test('caches a successful check until the TTL expires', async () => {
    let calls = 0;
    let now = 0;
    const client = new ConcordiumClient({
      fetch: async () => {
        calls++;
        return json(valid);
      },
      now: () => now,
      cacheTtlMs: 1000,
    });

    await client.checkBadge(BADGE);
    await client.checkBadge(BADGE);
    expect(calls).toBe(1);

    now = 1001;
    await client.checkBadge(BADGE);
    expect(calls).toBe(2);
  });

  test('returns unavailable on timeout', async () => {
    const hanging: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('Aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    const client = new ConcordiumClient({
      fetch: hanging,
      now: () => 0,
      timeoutMs: 10,
      retryDelayMs: 1,
    });
    const result = await client.verifyBadge(BADGE);

    expect(result.verdict).toBe('unavailable');
  });

  test('returns unavailable on a non-JSON body', async () => {
    const client = new ConcordiumClient({
      fetch: async () => new Response('not json', { status: 200 }),
      now: () => 0,
    });
    const result = await client.verifyBadge(BADGE);

    expect(result.verdict).toBe('unavailable');
    expect(result.error).toContain('non-JSON');
  });

  test('returns unavailable when the response shape is wrong', async () => {
    const client = new ConcordiumClient({
      fetch: async () => json({ nope: true }),
      now: () => 0,
    });
    const result = await client.verifyBadge(BADGE);

    expect(result.verdict).toBe('unavailable');
  });
});

describe('verdictOf', () => {
  test('verified when valid and active', () => {
    expect(verdictOf(check())).toBe('verified');
  });

  test('invalid when the badge checks fail', () => {
    expect(verdictOf(check({ badgeValid: false }))).toBe('invalid');
  });

  test('revoked when inactive', () => {
    expect(verdictOf(check({ status: 'Active', checks: { status_active: false } }))).toBe(
      'revoked',
    );
  });

  test('unknown when the agent is not on chain', () => {
    expect(verdictOf(check({ badgeValid: false, checks: { on_chain_agent_found: false } }))).toBe(
      'unknown',
    );
  });
});
