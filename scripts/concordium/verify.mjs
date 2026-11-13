#!/usr/bin/env node
// Independently verify every registered Penny agent and write CONCORDIUM_PROOF.md.
// No secrets. Reads the public config only.
//
// Usage: node scripts/concordium/verify.mjs

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MCP = 'https://agent-registry-mcp.concordium.com';
const CONFIG_FILE = join(process.cwd(), 'config', 'concordium-agents.json');
const PROOF_FILE = join(process.cwd(), 'CONCORDIUM_PROOF.md');
const config = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));

async function fetchWithTimeout(url, ms = 20000) {
  return fetch(url, { signal: AbortSignal.timeout(ms) });
}

const results = [];
let allOk = true;

for (const agent of config.agents) {
  let ok = false;
  let servedSha = 'unreachable';
  let check = null;
  let error = null;
  try {
    const cardResponse = await fetchWithTimeout(agent.cardUrl);
    if (!cardResponse.ok) throw new Error(`card HTTP ${cardResponse.status}`);
    const cardBytes = Buffer.from(await cardResponse.arrayBuffer());
    servedSha = createHash('sha256').update(cardBytes).digest('hex');

    const badgeResponse = await fetchWithTimeout(
      `${MCP}/v1/check-badge/${agent.badge}?network=testnet`,
    );
    if (!badgeResponse.ok) throw new Error(`check-badge HTTP ${badgeResponse.status}`);
    check = await badgeResponse.json();
    const c = check.checks ?? {};
    ok =
      check.badge_valid === true &&
      c.on_chain_agent_found === true &&
      c.status_active === true &&
      c.card_fetched === true &&
      c.hash_matches_on_chain === true &&
      c.owner_matches === true &&
      c.extension_conformant === true &&
      c.verification_present === true &&
      servedSha === agent.cardSha256;
  } catch (e) {
    error = e.message;
  }
  if (!ok) allOk = false;
  results.push({ agent, ok, servedSha, check, error });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${agent.slug} ${agent.badge}`);
}

const badgeRows = results
  .map(({ agent, ok, check }) => {
    const c = check?.checks ?? {};
    return `| ${agent.name} | ${agent.tokenId} | \`${agent.badge}\` | ${ok ? 'yes' : 'no'} | ${c.hash_matches_on_chain ? 'yes' : 'no'} | ${c.owner_matches ? 'yes' : 'no'} | ${c.verification_present ? 'yes' : 'no'} | [register](${agent.explorer.register}) | [pin](${agent.explorer.pin}) |`;
  })
  .join('\n');

const cardRows = results
  .map(
    ({ agent, servedSha }) =>
      `| ${agent.name} | ${agent.cardUrl} | \`${agent.cardSha256}\` | ${servedSha === agent.cardSha256 ? 'yes' : 'no'} |`,
  )
  .join('\n');

const failures = results
  .filter(({ ok }) => !ok)
  .map(({ agent, error }) => `- ${agent.name}: ${error ?? 'one or more checks failed'}`)
  .join('\n');

const proof = `# Concordium registration proof

Network: testnet (\`${config.chainId}\`)
Owner account: \`${config.ownerAccount}\`
Contracts: CIS-8004 \`<${config.contracts.cis8004.replace('.', ',')}>\`, CIS-8 \`<${config.contracts.cis8.replace('.', ',')}>\`
Checked: ${new Date().toISOString()}

## Badges

| Agent | Token | Badge | Verified | Card hash | Owner | Verification block | Register | Pin |
|---|---|---|---|---|---|---|---|---|
${badgeRows}

## Card hashes

| Agent | Card URL | SHA-256 | Served bytes match |
|---|---|---|---|
${cardRows}

## Verify it yourself

\`\`\`bash
# Replace <badge> with any badge above.
curl -s "https://agent-registry-mcp.concordium.com/v1/check-badge/<badge>?network=testnet" | jq .
\`\`\`

Every check above is computed from the registry MCP response and the served card bytes. The script does not trust the cards or the owner's local state.

## Hosting caveat

During this spike the cards are served from a temporary ngrok tunnel. The on-chain pins are correct, but the URLs stop resolving when the tunnel closes. Before submission, rebuild the cards against the stable base URL and re-pin each hash:

\`\`\`bash
CONCORDIUM_CARD_BASE_URL=https://raw.githubusercontent.com/tobi-techy/PENNY/main \\
  node scripts/concordium/build-cards.mjs penny guard invest mail
node scripts/concordium/register.mjs pin penny https://raw.githubusercontent.com/tobi-techy/PENNY/main/agents/penny/agent-card.json
# repeat pin for guard, invest, and mail
\`\`\`

${failures ? `## Failures\n\n${failures}\n` : ''}`;

writeFileSync(PROOF_FILE, proof);
console.log(`wrote ${PROOF_FILE} (${allOk ? 'all checks pass' : 'failures present'})`);
process.exitCode = allOk ? 0 : 1;
