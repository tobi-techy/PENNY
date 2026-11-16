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

// The recorded pinTx is human-maintained evidence, so it is exactly the kind of
// fact that silently rots (it did once already: Mail's entry kept the original
// ngrok pin after the card moved to the permanent host). Ask the registry for the
// real event log instead of trusting the file.
async function mcpTool(name, args) {
  const res = await fetch(`${MCP}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`${name} HTTP ${res.status}`);
  let raw = await res.text();
  if (raw.startsWith('event:')) {
    const dataLine = raw.split('\n').find((l) => l.startsWith('data: '));
    if (!dataLine) throw new Error(`${name}: no SSE data line`);
    raw = dataLine.slice(6);
  }
  const body = JSON.parse(raw);
  if (body.error) throw new Error(`${name}: ${body.error.message}`);
  const text = body.result?.content?.find((c) => c.type === 'text')?.text;
  if (!text) throw new Error(`${name}: empty result`);
  return JSON.parse(text);
}

// URIUpdated payload: tag, discriminator, token_id (u64 LE), flag, uri len (u32 LE),
// uri, flag, then the 32-byte metadata hash the contract anchored.
function decodeUriUpdated(rawHex) {
  const tokenId = Buffer.from(rawHex.slice(4, 20), 'hex').readBigUInt64LE(0);
  const uriLen = Buffer.from(rawHex.slice(22, 30), 'hex').readUInt32LE(0);
  const uriStart = 30;
  const uri = Buffer.from(rawHex.slice(uriStart, uriStart + uriLen * 2), 'hex').toString('utf8');
  const hashStart = uriStart + uriLen * 2 + 2;
  const hash = rawHex.slice(hashStart, hashStart + 64);
  return { tokenId: tokenId.toString(), uri, hash };
}

async function auditPin(agent) {
  const history = await mcpTool('agent_history', { network: 'testnet', token_id: agent.tokenId });
  const updates = (history.events ?? []).filter((e) => e.event_name === 'URIUpdated');
  if (updates.length === 0) return ['no URIUpdated event on chain'];
  const latest = updates[updates.length - 1];
  const decoded = decodeUriUpdated(latest.payload.raw_hex);
  const issues = [];
  if (latest.tx_hash !== agent.pinTx) {
    issues.push(
      `recorded pinTx ${agent.pinTx.slice(0, 16)}… != latest on chain ${latest.tx_hash.slice(0, 16)}…`,
    );
  }
  if (decoded.uri !== agent.cardUrl)
    issues.push(`on-chain uri ${decoded.uri} != config ${agent.cardUrl}`);
  if (decoded.hash !== agent.cardSha256) {
    issues.push(
      `on-chain hash ${decoded.hash.slice(0, 16)}… != config ${agent.cardSha256.slice(0, 16)}…`,
    );
  }
  return issues;
}

const results = [];
let allOk = true;

for (const agent of config.agents) {
  let ok = false;
  let servedSha = 'unreachable';
  let check = null;
  let error = null;
  let pinIssues = [];
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

  try {
    pinIssues = await auditPin(agent);
  } catch (e) {
    pinIssues = [`pin audit failed: ${e.message}`];
  }
  if (pinIssues.length > 0) ok = false;

  if (!ok && !error) error = pinIssues.join('; ');
  if (!ok) allOk = false;
  results.push({ agent, ok, servedSha, check, error, pinIssues });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${agent.slug} ${agent.badge}`);
  for (const issue of pinIssues) console.log(`     pin: ${issue}`);
}

const badgeRows = results
  .map(({ agent, ok, check, pinIssues }) => {
    const c = check?.checks ?? {};
    return `| ${agent.name} | ${agent.tokenId} | \`${agent.badge}\` | ${ok ? 'yes' : 'no'} | ${c.hash_matches_on_chain ? 'yes' : 'no'} | ${c.owner_matches ? 'yes' : 'no'} | ${c.verification_present ? 'yes' : 'no'} | ${pinIssues.length === 0 ? 'yes' : 'no'} | [register](${agent.explorer.register}) | [pin](${agent.explorer.pin}) |`;
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

| Agent | Token | Badge | Verified | Card hash | Owner | Verification block | Pin evidence | Register | Pin |
|---|---|---|---|---|---|---|---|---|---|
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

The **Pin evidence** column is an independent cross-check of the \`pinTx\` recorded in
\`config/concordium-agents.json\`: the script pulls the registry's own \`URIUpdated\`
event log for each token and asserts that the recorded transaction really is the
latest one, that the URI it carried is the configured \`cardUrl\`, and that the
SHA-256 it anchored is the configured \`cardSha256\`. A recorded hash can therefore
never drift from chain unnoticed.

## Hosting

Cards and passport pages are served from the permanent static host
\`https://penny-passport.vercel.app\` (source: \`apps/engine/public-static\`,
regenerated with \`bun run concordium:export\`). The card URL is part of the
hashed, on-chain-pinned bytes, so a host change requires rebuilding the cards
with the new \`CONCORDIUM_CARD_BASE_URL\`, re-pin, and redeploy:

\`\`\`bash
CONCORDIUM_CARD_BASE_URL=https://penny-passport.vercel.app \\
  node scripts/concordium/build-cards.mjs penny guard invest mail
bun run concordium:export
cd apps/engine/public-static && vercel --yes --prod
node scripts/concordium/register.mjs pin penny https://penny-passport.vercel.app/agents/penny/agent-card.json
# repeat pin for guard, invest, and mail
\`\`\`

${failures ? `## Failures\n\n${failures}\n` : ''}`;

writeFileSync(PROOF_FILE, proof);
console.log(`wrote ${PROOF_FILE} (${allOk ? 'all checks pass' : 'failures present'})`);
process.exitCode = allOk ? 0 : 1;
