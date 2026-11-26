#!/usr/bin/env node

// Penny pays Guard. This is the buyer half of the flow.
//
// Penny is a client, not a checkout page: it receives a 402 with requirements,
// signs a sponsored CCD transfer naming the facilitator as sponsor, retries, and
// gets the resource. It never broadcasts the transaction and never holds CCD for
// gas — the facilitator does both.
//
//   node src/pay.mjs [url]

import { AccountAddress } from '@concordium/web-sdk';
import { getExplorerTxUrl } from '@x402/concordium';
import { ExactConcordiumScheme } from '@x402/concordium/exact/client';
import { decodePaymentResponseHeader } from '@x402/core/http';
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { CAIP2, loadSigner, log, NETWORK, readRegistryConfig } from './shared.mjs';

const url = process.argv[2] ?? 'http://localhost:4020/guard/review?topic=acme-ltd';
const network = NETWORK === 'mainnet' ? CAIP2.mainnet : CAIP2.testnet;

const config = readRegistryConfig();
const payerAddress = process.env.PENNY_X402_PAYER ?? config.ownerAccount;

/**
 * Penny's own ceiling, in atomic CCD. CCD is not one of x402's default assets,
 * so it has to be opted into explicitly — and opting in with a cap rather than
 * disabling spend controls keeps the non-custodial promise intact: an agent
 * cannot be talked into an unbounded payment.
 */
const MAX_PER_PAYMENT = process.env.PENNY_X402_MAX_PER_PAYMENT ?? '2000000';

const { signer } = await loadSigner();

const payFetch = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [
    {
      network,
      client: new ExactConcordiumScheme({
        accountAddress: AccountAddress.fromBase58(payerAddress),
        signer,
      }),
    },
  ],
  spendControls: {
    allowedAssets: [{ network, asset: 'CCD', maxAmountPerPayment: MAX_PER_PAYMENT }],
  },
});

log(`paying as ${payerAddress}`);
log(`per-payment cap ${MAX_PER_PAYMENT} atomic CCD`);
log(`requesting ${url}`);

const response = await payFetch(url);
const body = await response.text();

log(`HTTP ${response.status}`);

const settlementHeader = response.headers.get('PAYMENT-RESPONSE');
if (settlementHeader) {
  const settlement = decodePaymentResponseHeader(settlementHeader);
  const tx = settlement.transaction;
  log(`settled: ${settlement.success ? 'yes' : 'no'}${tx ? ` tx ${tx}` : ''}`);
  if (tx) log('explorer:', getExplorerTxUrl(network, tx) ?? '(none)');
  if (settlement.errorReason) log('reason:', settlement.errorReason);
} else {
  log('no settlement header');
}

try {
  console.log(JSON.stringify(JSON.parse(body), null, 2));
} catch {
  console.log(body.slice(0, 800));
}

process.exitCode = response.ok ? 0 : 1;
