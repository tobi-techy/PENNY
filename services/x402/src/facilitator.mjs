#!/usr/bin/env node
// Penny's own x402 facilitator for Concordium.
//
// The facilitator is the piece that makes agent payments possible without the
// paying agent holding CCD for fees: it verifies the sender-signed sponsored
// transfer against x402's nine rules, adds its own sponsor signature, submits,
// and waits for finalisation. It can only ever sponsor the exact transfer it was
// asked to sponsor, so a malicious client cannot redirect it.
//
// We run it ourselves rather than depending on someone else's endpoint. The
// independent testnet facilitator referenced in x402 discussion answered 404 on
// /, /health and /supported when checked, so it is not something to build on.
//
// Exposes the standard x402 facilitator contract:
//   GET  /supported
//   POST /verify   { x402Version, paymentPayload, paymentRequirements }
//   POST /settle   { x402Version, paymentPayload, paymentRequirements }

import { serve } from '@hono/node-server';
import {
  CONCORDIUM_TESTNET_CAIP2,
  getConcordiumGrpcUrl,
  parseGrpcUrl,
  toConcordiumFacilitatorSigner,
} from '@x402/concordium';
import { ExactConcordiumScheme } from '@x402/concordium/exact/facilitator';
import { x402Facilitator } from '@x402/core/facilitator';
import { Hono } from 'hono';
import { CAIP2, GRPC, loadSigner, log, NETWORK, readRegistryConfig } from './shared.mjs';

const PORT = Number(process.env.PENNY_X402_FACILITATOR_PORT ?? 4021);

const config = readRegistryConfig();
const sponsor = process.env.PENNY_X402_SPONSOR ?? config.ownerAccount;
const network = NETWORK === 'mainnet' ? CAIP2.mainnet : CONCORDIUM_TESTNET_CAIP2;

const { signer: accountSigner } = await loadSigner();
const [host, port] = parseGrpcUrl(
  process.env.PENNY_X402_GRPC ?? GRPC[NETWORK] ?? getConcordiumGrpcUrl(network),
);

// The sponsor is the owner account. It pays network fees, never the transfer
// itself, and only for transfers whose recipient, amount, asset and expiry all
// match the requirements the resource server published.
const facilitatorSigner = toConcordiumFacilitatorSigner(sponsor, accountSigner, {
  host,
  port,
  useTls: true,
  network,
});

const scheme = new ExactConcordiumScheme({ signer: facilitatorSigner });

const facilitator = new x402Facilitator().register([network], scheme);

// Reject-and-log rather than silently swallow: a verified-but-unsettled payment
// is the one failure mode that costs a caller money without giving them service.
facilitator.onAfterSettle(async ({ result }) => {
  log('settled', result.transaction ?? '(no hash)', result.payer ?? '');
});
facilitator.onSettleFailure(async ({ error }) => {
  log('settle failed:', error.message);
});
facilitator.onAfterVerify(async ({ result }) => {
  if (!result.isValid) log('verify rejected:', result.invalidReason ?? 'unspecified');
});

const app = new Hono();

app.get('/supported', (c) => c.json(facilitator.getSupported()));

app.get('/health', (c) =>
  c.json({
    ok: true,
    sponsor,
    network,
    grpc: `${host}:${port}`,
    kinds: facilitator.getSupported().kinds,
  }),
);

app.post('/verify', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.paymentPayload || !body?.paymentRequirements) {
    return c.json({ isValid: false, invalidReason: 'malformed_request' }, 400);
  }
  try {
    return c.json(await facilitator.verify(body.paymentPayload, body.paymentRequirements));
  } catch (e) {
    log('verify threw:', e.message);
    return c.json({ isValid: false, invalidReason: 'facilitator_error', error: e.message }, 500);
  }
});

app.post('/settle', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.paymentPayload || !body?.paymentRequirements) {
    return c.json({ success: false, errorReason: 'malformed_request' }, 400);
  }
  try {
    return c.json(await facilitator.settle(body.paymentPayload, body.paymentRequirements));
  } catch (e) {
    log('settle threw:', e.message);
    return c.json({ success: false, errorReason: 'facilitator_error', error: e.message }, 500);
  }
});

serve({ fetch: app.fetch, port: PORT }, () => {
  log(`facilitator on http://localhost:${PORT}`);
  log(`sponsor ${sponsor}, network ${network}`);
  for (const kind of facilitator.getSupported().kinds) {
    log('supports', kind.scheme, kind.network, JSON.stringify(kind.extra ?? {}));
  }
});
