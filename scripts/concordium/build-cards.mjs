#!/usr/bin/env node
// Build the public Agent Cards for the registered Penny crew from the
// Concordium Agent Registry MCP, then add the ERC-8004 fields the MCP omits.
//
// Usage:
//   node scripts/concordium/build-cards.mjs guard invest mail
//   CONCORDIUM_CARD_BASE_URL=https://example.com node scripts/concordium/build-cards.mjs

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MCP = 'https://agent-registry-mcp.concordium.com';
const REPO = 'https://github.com/tobi-techy/PENNY';
const BASE_URL =
  process.env.CONCORDIUM_CARD_BASE_URL ?? 'https://nonunified-melda-inflexionally.ngrok-free.dev';
const STATE_FILE = join(process.cwd(), '.concordium', 'state.json');

const AGENTS = {
  penny: {
    name: 'Penny',
    image: 'penny-idle.svg',
    description:
      'Penny is the lead agent of a non-custodial money crew in iMessage. It routes plain-text asks to specialist agents, builds typed plans, and requires Face ID before any money moves.',
    skills: [
      {
        id: 'send-money',
        name: 'Send money',
        description: 'Prepare a USDC or NEAR send for Face ID approval.',
        tags: ['payments', 'near'],
      },
      {
        id: 'check-balances',
        name: 'Check balances',
        description: 'Read balances and recent activity.',
        tags: ['read'],
      },
      {
        id: 'split-a-bill',
        name: 'Split a bill',
        description: 'Prepare a split for approval without moving money first.',
        tags: ['bills'],
      },
      {
        id: 'review-bills',
        name: 'Review bills',
        description: 'Find, list, and close bills.',
        tags: ['bills'],
      },
      {
        id: 'reminders',
        name: 'Manage reminders',
        description: 'Set, list, and cancel reminders.',
        tags: ['reminders'],
      },
      {
        id: 'remember',
        name: 'Remember a preference',
        description: 'Remember durable preferences the user shares.',
        tags: ['memory'],
      },
      {
        id: 'route-crew',
        name: 'Route to the crew',
        description: 'Route an ask to Invest, Guard, Mail, Finance, or Errand.',
        tags: ['routing'],
      },
    ],
  },
  guard: {
    name: 'Guard',
    image: 'bot-guard.svg',
    description:
      "Guard is Penny's spending-policy agent. It checks every money plan against caps, allowlists, velocity, and new-recipient rules before a card is shown, and explains blocks in plain language.",
    skills: [
      {
        id: 'check-spend',
        name: 'Check a spend',
        description: "Check a money plan against the user's Guard policy before approval.",
        tags: ['policy', 'money'],
      },
      {
        id: 'explain-decision',
        name: 'Explain a decision',
        description: 'Explain why a spend was allowed or blocked in plain language.',
        tags: ['policy'],
      },
      {
        id: 'recall-decisions',
        name: 'Recall decisions',
        description: 'Recall past Guard decisions for this user.',
        tags: ['history'],
      },
    ],
  },
  invest: {
    name: 'Invest',
    image: 'bot-invest.svg',
    description:
      "Invest is Penny's portfolio agent. It reads balances and portfolios, quotes swaps, and prepares investments for Guard checks and Face ID approval.",
    skills: [
      {
        id: 'review-portfolio',
        name: 'Review a portfolio',
        description: 'Read balances and portfolio positions.',
        tags: ['read', 'portfolio'],
      },
      {
        id: 'quote-invest',
        name: 'Quote an investment',
        description: 'Quote a swap or investment before approval.',
        tags: ['quote', 'near'],
      },
      {
        id: 'propose-invest',
        name: 'Prepare an investment',
        description: 'Prepare an investment plan for Guard and Face ID approval.',
        tags: ['invest', 'approval'],
      },
      {
        id: 'remember-preferences',
        name: 'Remember preferences',
        description: 'Remember durable investment preferences the user shares.',
        tags: ['memory'],
      },
    ],
  },
  mail: {
    name: 'Mail',
    image: 'bot-mail.svg',
    description:
      "Mail is Penny's inbox and bills agent. It finds bills in mail, drafts replies, prepares payments, and sets reminders. Sending and paying still need the user's approval.",
    skills: [
      {
        id: 'find-bills',
        name: 'Find bills',
        description: 'Find bills and due dates in connected mail.',
        tags: ['bills', 'email'],
      },
      {
        id: 'draft-email',
        name: 'Draft an email',
        description: 'Draft an email or reply for the user to review.',
        tags: ['email', 'draft'],
      },
      {
        id: 'prepare-payment',
        name: 'Prepare a bill payment',
        description: 'Prepare a bill payment for Guard and Face ID approval.',
        tags: ['bills', 'payment'],
      },
      {
        id: 'reminders',
        name: 'Manage reminders',
        description: 'Set, list, and cancel reminders.',
        tags: ['reminders'],
      },
    ],
  },
};

async function mcpTool(name, args) {
  const r = await fetch(`${MCP}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
    signal: AbortSignal.timeout(20000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`MCP ${name} HTTP ${r.status}: ${text.slice(0, 200)}`);
  const j = JSON.parse(text);
  if (j.error) throw new Error(`MCP ${name}: ${JSON.stringify(j.error)}`);
  const content = j.result?.content?.[0]?.text;
  if (!content) throw new Error(`MCP ${name}: no content`);
  return JSON.parse(content);
}

const state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
const slugs = process.argv.slice(2);
if (slugs.length === 0) {
  console.error('usage: node scripts/concordium/build-cards.mjs <slug> [slug...]');
  process.exit(1);
}

for (const slug of slugs) {
  const meta = AGENTS[slug];
  if (!meta) throw new Error(`unknown agent: ${slug}`);
  const agent = state.agents?.[slug];
  if (!agent?.tokenId) throw new Error(`no token for ${slug}; register first`);

  const cardUrl = `${BASE_URL}/agents/${slug}/agent-card.json`;
  const built = await mcpTool('build_agent_card', {
    network: 'testnet',
    name: meta.name,
    description: meta.description,
    agent_uri: cardUrl,
    owner_account: state.address,
    token_id: agent.tokenId,
    version: '1.0.0',
    documentation_url: REPO,
    provider: { organization: 'Penny', url: REPO },
    services: { repository: REPO },
    skills: meta.skills,
  });

  const card = JSON.parse(built.agent_card_json);
  Object.assign(card, {
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    image: `https://raw.githubusercontent.com/tobi-techy/PENNY/main/brand/assets/${meta.image}`,
    active: true,
    x402Support: false,
    documentationUrl: REPO,
  });

  const bytes = `${JSON.stringify(card, null, 2)}\n`;
  const dir = join(process.cwd(), 'agents', slug);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'agent-card.json');
  writeFileSync(file, bytes);
  const sha = createHash('sha256').update(bytes).digest('hex');
  agent.cardUrl = cardUrl;
  agent.cardSha = sha;
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
  console.log(`${slug}\t${agent.tokenId}\t${sha}\t${cardUrl}`);
}
