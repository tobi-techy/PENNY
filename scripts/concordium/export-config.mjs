#!/usr/bin/env node
// Export the public Concordium facts for the crew. No seeds, no keys.
// Reads .concordium/state.json (gitignored) and writes config/concordium-agents.json.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const STATE_FILE = join(process.cwd(), '.concordium', 'state.json');
const OUT_FILE = join(process.cwd(), 'config', 'concordium-agents.json');
const NAMES = { penny: 'Penny', guard: 'Guard', invest: 'Invest', mail: 'Mail' };
const ORDER = ['penny', 'guard', 'invest', 'mail'];

const state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
const agents = ORDER.filter((slug) => state.agents?.[slug]?.badge).map((slug) => {
  const agent = state.agents[slug];
  return {
    slug,
    name: NAMES[slug],
    tokenId: agent.tokenId,
    badge: agent.badge,
    cardUrl: agent.cardUrl,
    cardSha256: agent.cardSha,
    registerTx: agent.registerTx,
    pinTx: agent.pinTx,
    explorer: {
      account: `https://ccdexplorer.io/testnet/account/${state.address}`,
      register: `https://ccdexplorer.io/testnet/transaction/${agent.registerTx}`,
      pin: `https://ccdexplorer.io/testnet/transaction/${agent.pinTx}`,
      verify: `https://agent-registry-mcp.concordium.com/v1/check-badge/${agent.badge}?network=testnet`,
    },
  };
});

const config = {
  network: 'testnet',
  chainId: `ccd:${state.chainId}`,
  ownerAccount: state.address,
  contracts: { cis8004: '12802.0', cis8: '12801.0' },
  agents,
};

mkdirSync(join(process.cwd(), 'config'), { recursive: true });
writeFileSync(OUT_FILE, `${JSON.stringify(config, null, 2)}\n`);
console.log(`wrote ${OUT_FILE} (${agents.length} agents)`);
