/**
 * Testnet end-to-end checklist runner (NEAR testnet only).
 *
 * Read-only + dry-run by default: verifies the RPC answers, deterministically
 * builds a $1 USDC send, plans a Guard set_policy, and reports what is still
 * needed for a live run. A live run additionally requires:
 *   PENNY_TESTNET_E2E_LIVE=1, a funded testnet user account with an enrolled
 *   device key, NEAR_RELAYER_* keys, and DRY_RUN=0 with PENNY_ENV unset/dev.
 * Never point this at mainnet: it refuses non-testnet RPC URLs.
 *
 * Run: bun apps/engine/scripts/testnet-e2e.ts
 */
import { chainAdapterFromEnv, GuardContract, guardContractId } from '@penny/chain';
import { RealChain } from '../src/ports/real-chain.ts';

const rpcUrl = process.env.NEAR_RPC_URL ?? '';
if (!rpcUrl.includes('testnet')) {
  console.error(`refusing: NEAR_RPC_URL must be a testnet endpoint (got ${rpcUrl || 'unset'})`);
  process.exit(1);
}

const adapter = chainAdapterFromEnv(process.env, { resolveDeviceKey: async () => null });
const chain = new RealChain(adapter);

const user = process.env.PENNY_TEST_USER ?? 'penny.testnet';
console.log('1. RPC block height:', (await adapter.rpc.finalBlock()).height.toString());
try {
  const built = await chain.buildActions(
    { kind: 'send', asset: 'NEAR', amount: '0.1', to: user },
    user,
  );
  console.log(
    '2. dry buildActions 0.1 NEAR send ->',
    built.receiverId,
    `${built.actions.length} action(s)`,
  );
} catch (e) {
  console.log('2. buildActions needs funded account/keys:', (e as Error).message.slice(0, 120));
}
const guard = new GuardContract({
  rpc: adapter.rpc,
  contractId: guardContractId(user),
  ownerAccountId: user,
  mode: adapter.mode,
});
const dryPolicy = await guard.setPolicy(`invest.${user}`, {
  limits: [{ token: 'usdc-test.near', perTxCap: '25000000', dailyCap: '50000000' }],
});
console.log('3. guard set_policy dry plan:', dryPolicy.mode, guard.contractId);
console.log(
  '4. guard policy view:',
  await guard.getPolicy(`invest.${user}`).catch(() => 'not deployed yet'),
);
console.log(
  process.env.PENNY_TESTNET_E2E_LIVE === '1'
    ? 'LIVE mode requested: complete a device-signed $1 send via the engine, then set PENNY_TESTNET_E2E_OK=1 only after the card settles.'
    : 'Dry checklist complete. For the live leg: fund the testnet user, enroll a device, run the engine with DRY_RUN=0, send $1 from iMessage, and confirm settled here via txStatus.',
);
