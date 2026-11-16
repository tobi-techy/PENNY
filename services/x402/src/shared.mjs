// Shared configuration for the Penny x402 service.
//
// Runs on Node, not Bun: @concordium/web-sdk v12 (pulled in by @x402/concordium)
// is not importable under Bun, same constraint as scripts/concordium/*.mjs.
//
// The service sits outside the Bun workspace on purpose. The repo pins web-sdk
// 9.2.0 for the registration scripts and @x402/concordium requires ^12, so this
// tree carries its own node_modules rather than forcing a breaking bump.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Bun's `import.meta.dir` is not available here; this tree runs on Node.
const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, '../../..');

export const NETWORK = process.env.PENNY_X402_NETWORK ?? 'testnet';

/** CAIP-2 ids; these must match what the registry and the x402 package use. */
export const CAIP2 = {
  testnet: 'ccd:4221332d34e1694168c2a0c0b3fd0f27',
  mainnet: 'ccd:9dd9ca4d19e9393877d2c44b70f89acb',
};

export const GRPC = {
  testnet: 'grpc.testnet.concordium.com:20000',
  mainnet: 'grpc.mainnet.concordium.software:20000',
};

/** The public registry config: owner account, agents, badges, card pins. */
export function readRegistryConfig() {
  const path = join(REPO, 'config/concordium-agents.json');
  if (!existsSync(path)) throw new Error(`missing ${path}`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * The owner account's signing key, derived from the gitignored seed.
 *
 * Testnet only. Nothing here is ever logged: callers that need the key pass it
 * straight into a signer and never into a message.
 */
export function loadSigner() {
  const seedPath = process.env.PENNY_CONCORDIUM_SEED ?? join(REPO, '.concordium/seed.txt');
  if (!existsSync(seedPath)) {
    throw new Error('no Concordium seed; set PENNY_CONCORDIUM_SEED or run the account stage');
  }
  const seed = readFileSync(seedPath, 'utf8').trim();
  return import('@concordium/web-sdk').then((sdk) => {
    const wallet = sdk.ConcordiumHdWallet.fromHex(seed, 'Testnet');
    const keyHex = wallet.getAccountSigningKey(0, 0, 0).toString('hex');
    return { signer: sdk.buildBasicAccountSigner(keyHex), sdk };
  });
}

export function log(...args) {
  console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...args);
}
