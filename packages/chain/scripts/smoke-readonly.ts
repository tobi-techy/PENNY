/**
 * Read-only mainnet smoke test. Makes NO transactions: only RPC view calls and a 1Click dry quote.
 *   bun run scripts/smoke-readonly.ts
 * Env (optional): NEAR_RPC_URL, NEAR_APP_ACCOUNT_ID (default penny.near), ONECLICK_API_KEY.
 */

import { OneClickClient } from '../src/intents/oneclick.ts';
import { deriveEvmAddress } from '../src/near/chainsig.ts';
import { ftMetadata, storageBalanceOf, USDC_ASSET_ID, USDC_CONTRACT } from '../src/near/ft.ts';
import { MAINNET_RPC_URL, NearRpc } from '../src/near/rpc.ts';

const rpc = new NearRpc({ url: process.env.NEAR_RPC_URL ?? MAINNET_RPC_URL });
const app = process.env.NEAR_APP_ACCOUNT_ID ?? 'penny.near';
const results: Record<string, unknown> = {};
let failed = false;
async function step(name: string, fn: () => Promise<unknown>) {
  try {
    results[name] = await fn();
    console.log(
      `ok   ${name}`,
      JSON.stringify(results[name], (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
    );
  } catch (e) {
    failed = true;
    console.log(`FAIL ${name}: ${(e as Error).message}`);
  }
}

await step('rpc.finalBlock', () => rpc.finalBlock());
await step(`account ${app}`, async () => {
  const a = await rpc.viewAccount(app);
  if (!a) return { exists: false };
  const keys = await rpc.viewAccessKeyList(app);
  return {
    exists: true,
    balanceYocto: a.amount.toString(),
    hasContract: a.codeHash !== '11111111111111111111111111111111',
    keys: keys.keys.length,
  };
});
await step('account tobi.penny.near', async () => ({
  exists: (await rpc.viewAccount('tobi.penny.near')) !== null,
}));
await step('usdc.ft_metadata', async () => {
  const m = await ftMetadata(rpc, USDC_CONTRACT);
  if (m.symbol !== 'USDC' || m.decimals !== 6)
    throw new Error(`unexpected metadata ${m.symbol}/${m.decimals}`);
  return { symbol: m.symbol, decimals: m.decimals, spec: m.spec };
});
await step('usdc.storage_balance_bounds', () =>
  rpc.callView(USDC_CONTRACT, 'storage_balance_bounds'),
);
await step(
  'usdc.storage_balance_of(intents.near)',
  async () => (await storageBalanceOf(rpc, USDC_CONTRACT, 'intents.near'))?.toString() ?? null,
);
await step(`chainsig.derived EVM owner for ${app}`, () => deriveEvmAddress(rpc, app));

const oc = new OneClickClient(
  process.env.ONECLICK_API_KEY ? { apiKey: process.env.ONECLICK_API_KEY } : {},
);
await step('1click.tokens(USDC on NEAR listed)', async () => {
  const t = await oc.getTokens();
  const u = t.find((x) => x.assetId === USDC_ASSET_ID);
  if (!u) throw new Error('USDC not listed');
  return { total: t.length, usdc: { decimals: u.decimals, price: u.price } };
});
await step('1click.quote dry 1 USDC -> wNEAR', async () => {
  const q = await oc.quote({
    dry: true,
    originAsset: USDC_ASSET_ID,
    destinationAsset: 'nep141:wrap.near',
    amount: 1_000_000n,
    slippageBps: 100,
    recipient: app,
    refundTo: app,
  });
  return {
    amountIn: q.amountIn,
    amountOut: q.amountOut,
    minAmountOut: q.minAmountOut,
    expiresAt: q.expiresAt.toISOString(),
    timeEstimate: q.response.quote.timeEstimate,
  };
});
await step('1click.quote dry 1 USDC -> USDC on Base', async () => {
  const q = await oc.quote({
    dry: true,
    originAsset: USDC_ASSET_ID,
    destinationAsset: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
    amount: 1_000_000n,
    slippageBps: 100,
    // 1Click rejects burn addresses; use the Chain-Signatures-derived EVM owner of the app account (read-only derivation).
    recipient:
      (results[`chainsig.derived EVM owner for ${app}`] as { address?: string } | undefined)
        ?.address ?? '0xE7f27180c3a48CAcF569208Da6b22b0f3460F1FD',
    refundTo: app,
  });
  return { amountIn: q.amountIn, amountOut: q.amountOut, minAmountOut: q.minAmountOut };
});

console.log(
  failed
    ? '\nSMOKE: some steps failed'
    : '\nSMOKE: all read-only checks passed (no transactions sent)',
);
process.exit(failed ? 1 : 0);
