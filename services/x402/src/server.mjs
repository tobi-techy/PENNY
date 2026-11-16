#!/usr/bin/env node
// Guard's paid endpoint: the seller half of Penny's Concordium agent payment.
//
// Three things happen on one request, and each is load-bearing:
//
//  1. `payTo` is not a constant. It is read from Guard's on-chain CIS-8004
//     `agentWallet`, so the registry is the source of truth for where an agent
//     gets paid. Repoint the registry entry and this follows.
//  2. An agent without a valid Verified by Concordium badge is refused before
//     any payment is processed. The seller asks whether a verified human stands
//     behind the buyer, which is the reverse of the usual direction of trust.
//  3. Settlement goes through our own facilitator, which sponsors the network
//     fee, so the buyer needs CCD for the price but never for gas.

import { serve } from '@hono/node-server';
import { CONCORDIUM_TESTNET_CAIP2 } from '@x402/concordium';
import { ExactConcordiumScheme } from '@x402/concordium/exact/server';
import { decodePaymentSignatureHeader, HTTPFacilitatorClient } from '@x402/core/http';
import { paymentMiddlewareFromConfig } from '@x402/hono';
import { Hono } from 'hono';
import { CAIP2, log, NETWORK, readRegistryConfig } from './shared.mjs';

const PORT = Number(process.env.PENNY_X402_PORT ?? 4020);
const FACILITATOR_URL = process.env.PENNY_X402_FACILITATOR_URL ?? 'http://localhost:4021';
const MCP = process.env.PENNY_REGISTRY_MCP ?? 'https://agent-registry-mcp.concordium.com';
const network = NETWORK === 'mainnet' ? CAIP2.mainnet : CONCORDIUM_TESTNET_CAIP2;

const config = readRegistryConfig();
const GUARD = config.agents.find((a) => a.slug === 'guard');
if (!GUARD) throw new Error('guard is not in the registry config');

/** Price in atomic units: 0.5 CCD. */
const PRICE = process.env.PENNY_X402_PRICE ?? '500000';

async function getJson(url, init) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

async function mcpTool(name, args) {
  const body = await getJson(`${MCP}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  if (body.error) throw new Error(`${name}: ${body.error.message}`);
  const text = body.result?.content?.find((c) => c.type === 'text')?.text;
  if (!text) throw new Error(`${name}: empty result`);
  return JSON.parse(text);
}

/**
 * Where Guard gets paid, straight from the agent record. Falls back to the owner
 * account only if the registry is unreachable, and says so, because silently
 * paying the wrong address is worse than failing to start.
 */
async function resolvePayTo() {
  const override = process.env.PENNY_X402_PAY_TO;
  if (override) {
    log('payTo from PENNY_X402_PAY_TO:', override);
    return override;
  }
  try {
    const agent = await mcpTool('agent_of', { network: NETWORK, token_id: GUARD.tokenId });
    const wallet = agent?.agent_wallet ?? agent?.agentWallet;
    if (wallet) {
      log(`payTo from CIS-8004 agentWallet (token ${GUARD.tokenId}):`, wallet);
      return wallet;
    }
    log('agent record has no agentWallet; falling back to owner account');
  } catch (e) {
    log('registry lookup failed:', e.message, '— falling back to owner account');
  }
  return config.ownerAccount;
}

const payTo = await resolvePayTo();

/**
 * Does a verified human stand behind the agent paying us?
 *
 * Fails closed. If the registry cannot answer, we do not take money we cannot
 * account for.
 */
async function payerHasBadge(payer) {
  try {
    const result = await mcpTool('check_account_badges', {
      network: NETWORK,
      owner_account: payer,
    });
    const valid = Number(result?.summary?.valid ?? result?.valid_count ?? 0);
    const agents = Array.isArray(result?.agents) ? result.agents : [];
    const anyValid = agents.some((a) => a?.badge_valid === true);
    const ok = valid > 0 || anyValid;
    log(`badge gate: ${payer} -> ${ok ? 'verified' : 'NO BADGE'} (${agents.length} agents)`);
    return { ok, detail: { valid, agents: agents.length } };
  } catch (e) {
    log(`badge gate: ${payer} -> registry error (${e.message}); refusing`);
    return { ok: false, detail: { error: e.message } };
  }
}

const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR_URL });

const routes = {
  'GET /guard/review': {
    accepts: {
      scheme: 'exact',
      network,
      payTo,
      price: { amount: PRICE, asset: 'CCD' },
    },
    description: 'Guard reviews a plan, a contract, or a counterparty and returns a risk note.',
    mimeType: 'application/json',
  },
};

const app = new Hono();

const paywall = paymentMiddlewareFromConfig(routes, facilitatorClient, [
  { network, server: new ExactConcordiumScheme() },
]);

// Refuse unverified buyers before the payment is processed, so an agent with no
// badge is turned away without being charged.
const gate = async (c, next) => {
  const header = c.req.header('PAYMENT-SIGNATURE') ?? c.req.header('X-PAYMENT');
  if (!header) {
    // First leg: the 402 quote is free, and it is how a buyer learns the price.
    await next();
    return;
  }
  let payer;
  try {
    const payment = decodePaymentSignatureHeader(header);
    payer = payment?.payload?.sender ?? payment?.payload?.signedTransaction?.header?.sender;
  } catch (e) {
    log('could not read the paying account:', e.message);
    return c.json({ error: 'unreadable_payment' }, 400);
  }
  if (!payer) return c.json({ error: 'no_payer' }, 400);
  const gateResult = await payerHasBadge(payer);
  if (!gateResult.ok) {
    return c.json(
      {
        error: 'verified_badge_required',
        message:
          'This agent only sells to agents that carry a Verified by Concordium badge, so a verified human stands behind the buyer.',
        payer,
        how: 'https://agent-registry.concordium.com/',
        detail: gateResult.detail,
      },
      403,
    );
  }
  c.set('payer', payer);
  await next();
};

app.get('/guard/review', gate, paywall, async (c) => {
  const topic = c.req.query('topic') ?? 'unspecified counterparty';
  return c.json({
    reviewer: 'Guard',
    tokenId: GUARD.tokenId,
    badge: GUARD.badge,
    subject: topic,
    verdict: 'caution',
    notes: [
      `Reviewed "${topic}" against the crew's standing policy.`,
      'This is a demonstration review, not financial or legal advice.',
    ],
    paidBy: c.get('payer') ?? null,
    settledIn: 'CCD on Concordium testnet',
    registry: 'https://agent-registry-mcp.concordium.com',
  });
});

app.get('/health', (c) =>
  c.json({ ok: true, payTo, network, price: PRICE, facilitator: FACILITATOR_URL }),
);

serve({ fetch: app.fetch, port: PORT }, () => {
  log(`seller on http://localhost:${PORT}`);
  log(`payTo ${payTo}, price ${PRICE} (atomic CCD), network ${network}`);
  log(`facilitator ${FACILITATOR_URL}`);
});
