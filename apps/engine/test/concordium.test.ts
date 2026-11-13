import { describe, expect, test } from 'bun:test';
import { ConcordiumClient } from '@penny/concordium';
import type { ToolContext } from '../src/brain/registry.ts';
import { createRegistry } from '../src/brain/tools.ts';

const OWNER = '3ewJGpdgo6NcDt36tmhnakMv9YB1qBQNPQBAinEJy9T1dpujfT';
const BADGE = 'JyP9Wd81dn3JwiAs6agks';

const valid = {
  token_id: 1169,
  token_address: BADGE,
  agent_uri: 'https://example.test/agent-card.json',
  on_chain: { owner_account: OWNER, status: 'Active' },
  checks: { on_chain_agent_found: true, status_active: true, hash_matches_on_chain: true },
  badge_valid: true,
  issues: [],
  network: 'testnet',
};

function clientWith(body: unknown, status = 200): ConcordiumClient {
  return new ConcordiumClient({
    fetch: async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    now: () => 0,
  });
}

function ctx(concordium?: ConcordiumClient): ToolContext {
  return { concordium } as unknown as ToolContext;
}

describe('verify_agent', () => {
  test('is registered read-only', () => {
    const tool = createRegistry().get('verify_agent');
    expect(tool?.risk).toBe('read');
  });

  test('returns the verdict and public evidence', async () => {
    const tool = createRegistry().get('verify_agent');
    if (!tool) throw new Error('verify_agent missing');
    const out = await tool.execute(ctx(clientWith(valid)), { badge: BADGE });
    expect(out).toMatchObject({
      ok: true,
      verdict: 'verified',
      owner: OWNER,
      status: 'Active',
      subject: BADGE,
    });
  });

  test('accepts an owner account as the subject', async () => {
    const tool = createRegistry().get('verify_agent');
    if (!tool) throw new Error('verify_agent missing');
    const out = await tool.execute(ctx(clientWith(valid)), { account: OWNER });
    expect(out).toMatchObject({ ok: true, verdict: 'verified' });
  });

  test('an account is answered with a roll-up across every agent it owns', async () => {
    const tool = createRegistry().get('verify_agent');
    if (!tool) throw new Error('verify_agent missing');
    // The real account shape: four agents, one of them failing.
    const owner = {
      network: 'testnet',
      account: OWNER,
      agent_count: 4,
      summary: { valid: 3, invalid: 1 },
      agents: [0, 1, 2, 3].map((i) => ({
        ...valid,
        token_id: 1169 + i,
        badge_valid: i < 3,
        issues: i < 3 ? [] : [{ severity: 'error', field: 'card_fetch', message: '404' }],
      })),
    };
    const out = await tool.execute(ctx(clientWith(owner)), { account: OWNER });
    expect(out).toMatchObject({
      ok: true,
      verdict: 'invalid',
      subject: OWNER,
      agentCount: 4,
      validCount: 3,
      invalidCount: 1,
    });
    expect((out as { agents: unknown[] }).agents).toHaveLength(4);
  });

  test('a badge subject stays a single check, not an owner roll-up', async () => {
    const tool = createRegistry().get('verify_agent');
    if (!tool) throw new Error('verify_agent missing');
    const out = await tool.execute(ctx(clientWith(valid)), { badge: BADGE });
    expect(out).toMatchObject({ ok: true, verdict: 'verified', subject: BADGE });
    expect(out).not.toHaveProperty('agentCount');
  });

  test('says verification is off when no client is configured', async () => {
    const tool = createRegistry().get('verify_agent');
    if (!tool) throw new Error('verify_agent missing');
    const out = await tool.execute(ctx(), { badge: BADGE });
    expect(out).toEqual({ ok: false, error: 'concordium verification is off' });
  });

  test('returns unavailable on a registry error', async () => {
    const tool = createRegistry().get('verify_agent');
    if (!tool) throw new Error('verify_agent missing');
    const out = await tool.execute(ctx(clientWith({}, 500)), { badge: BADGE });
    expect(out).toMatchObject({ ok: true, verdict: 'unavailable' });
  });
});
