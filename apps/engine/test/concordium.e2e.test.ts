import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConcordiumClient } from '@penny/concordium';

/**
 * Live check against the public Concordium Agent Registry. Skipped unless
 * CONCORDIUM_LIVE=1, so CI never depends on a third party. Run it before a
 * demo or a submission: the card URL is inside the hashed bytes pinned on
 * chain, so a dead card host would otherwise surface as an invalid badge.
 *
 *   CONCORDIUM_LIVE=1 bun test apps/engine/test/concordium.e2e.test.ts
 */

const live = process.env.CONCORDIUM_LIVE === '1';

const configPath = join(import.meta.dir, '../../../config/concordium-agents.json');

describe('concordium badges (live registry)', () => {
  test.skipIf(!live)('every registered badge verifies against the live registry', async () => {
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
      agents: { slug: string; badge: string }[];
    };
    const client = new ConcordiumClient({ network: 'testnet' });
    const failures: string[] = [];

    for (const agent of config.agents) {
      const result = await client.verifyBadge(agent.badge);
      if (result.verdict !== 'verified') {
        failures.push(
          `${agent.slug}: ${result.verdict}${result.error ? ` (${result.error})` : ''}`,
        );
      }
      expect(result.error).toBeUndefined();
      expect(result.check.checks.hash_matches_on_chain).toBe(true);
      expect(result.check.checks.owner_matches).toBe(true);
      expect(result.check.issues).toEqual([]);
    }

    expect(failures).toEqual([]);
  });
});
