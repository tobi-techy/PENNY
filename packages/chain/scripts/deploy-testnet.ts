/**
 * Deploy the shared Guard and the test dollar (tUSD), and create the demo biller,
 * on NEAR testnet. Testnet only: the script refuses any RPC URL without "testnet".
 *
 * The accounts are created locked (no access key is added), and `new` runs in the
 * same transaction as the deploy, signed by the parent. After that nobody, Penny
 * included, can redeploy or drain them.
 *
 * Required env (testnet full-access key of the parent account):
 *   NEAR_DEPLOYER_ACCOUNT_ID=penny.testnet
 *   NEAR_DEPLOYER_PRIVATE_KEY=ed25519:...
 * Optional:
 *   NEAR_RPC_URL=https://rpc.testnet.near.org
 *   GUARD_ACCOUNT_ID=guard.<deployer>
 *   TUSD_ACCOUNT_ID=tusd.<deployer>
 *   DEMO_BILLER_ACCOUNT_ID=biller.<deployer>
 *   MINT_TUSD=10000000            # $10.00 (6 decimals) to the biller
 *   PENNY_USER_ACCOUNT_ID=        # also mint $10.00 to this account
 *
 * Run: bun run deploy:testnet
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { actionCreators, type Action } from '@near-js/transactions';
import { KeyPairSigner } from '../src/near/keys.ts';
import { NearRpc } from '../src/near/rpc.ts';
import { buildTx, signTx } from '../src/near/tx.ts';

const TGAS = 1_000_000_000_000n;
const NEAR = 1_000_000_000_000_000_000_000_000n;
const GAS = 30n * TGAS;
const CREATE_BALANCE = 5n * NEAR;
const BILLER_BALANCE = 1n * NEAR;
const DOCUMENTED_GUARD_SHA256 =
  '90fe7051ce2ec03b9c6e7bd41a88b430ca496818eaa08a647d271cdedb968984';
const DOCUMENTED_TUSD_SHA256 =
  '2b8baf9d53496cb63d7410915132fc07d12b6338db8fb998a271cf3a75fe5d57';

const env = (k: string): string | undefined => process.env[k]?.trim() || undefined;
const fail = (msg: string): never => {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
};
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const json = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

const rpcUrl = env('NEAR_RPC_URL') ?? 'https://rpc.testnet.near.org';
if (!rpcUrl.includes('testnet')) fail(`refusing: NEAR_RPC_URL is not testnet (${rpcUrl})`);

const deployer = env('NEAR_DEPLOYER_ACCOUNT_ID') ?? fail('NEAR_DEPLOYER_ACCOUNT_ID is unset');
const secret = env('NEAR_DEPLOYER_PRIVATE_KEY') ?? fail('NEAR_DEPLOYER_PRIVATE_KEY is unset');
if (!secret.startsWith('ed25519:')) fail('NEAR_DEPLOYER_PRIVATE_KEY must be ed25519:...');

const guardId = env('GUARD_ACCOUNT_ID') ?? `guard.${deployer}`;
const tusdId = env('TUSD_ACCOUNT_ID') ?? `tusd.${deployer}`;
const billerId = env('DEMO_BILLER_ACCOUNT_ID') ?? `biller.${deployer}`;
const mintAmount = env('MINT_TUSD') ?? '10000000';
const userAccount = env('PENNY_USER_ACCOUNT_ID');

for (const [label, id] of [
  ['guard', guardId],
  ['tUSD', tusdId],
  ['demo biller', billerId],
] as const) {
  if (!id.endsWith(`.${deployer}`))
    fail(`${label} account "${id}" must be a direct sub-account of ${deployer}`);
}

const root = join(import.meta.dir, '..', '..', '..');
const guardWasm = readFileSync(join(root, 'contracts', 'guard', 'res', 'penny_guard.wasm'));
const tusdWasm = readFileSync(join(root, 'contracts', 'guard', 'res', 'test_usd.wasm'));
const guardHash = sha256(guardWasm);
const tusdHash = sha256(tusdWasm);
if (guardHash !== DOCUMENTED_GUARD_SHA256)
  fail(
    `penny_guard.wasm sha256 ${guardHash} does not match the documented ${DOCUMENTED_GUARD_SHA256}. Rebuild with contracts/guard/build.sh and update contracts/guard/README.md.`,
  );
if (tusdHash !== DOCUMENTED_TUSD_SHA256)
  fail(
    `test_usd.wasm sha256 ${tusdHash} does not match the documented ${DOCUMENTED_TUSD_SHA256}. Rebuild with contracts/guard/build.sh.`,
  );

const rpc = new NearRpc({ url: rpcUrl });
const signer = new KeyPairSigner(deployer, secret);
const access = await rpc.viewAccessKey(deployer, signer.publicKey.toString());
if (!access) {
  fail(`no access key ${signer.publicKey} on ${deployer}`);
  process.exit(1);
}
const blockHash: string = access.blockHash;
let nonce = access.nonce;

async function send(label: string, receiverId: string, actions: Action[]): Promise<void> {
  nonce += 1n;
  const built = buildTx({
    signerId: deployer,
    signerPublicKey: signer.publicKey,
    receiverId,
    nonce,
    actions,
    blockHash,
  });
  const signed = await signTx(built, signer);
  const outcome = (await rpc.sendTx(signed.signedBase64, 'EXECUTED_OPTIMISTIC')) as {
    status?: { SuccessValue?: string; Failure?: unknown };
  };
  const failed = outcome?.status?.Failure !== undefined;
  console.log(`${failed ? '✗' : '✓'} ${label}: ${receiverId} (${built.hash})`);
  if (failed) fail(`${label} failed: ${JSON.stringify(outcome.status?.Failure)}`);
  console.log(`  https://testnet.nearblocks.io/txns/${built.hash}`);
}

async function create(
  label: string,
  accountId: string,
  actions: Action[],
): Promise<boolean> {
  if (await rpc.viewAccount(accountId)) {
    console.log(`• ${label}: ${accountId} already exists, leaving it alone`);
    return false;
  }
  await send(label, accountId, [actionCreators.createAccount(), ...actions]);
  return true;
}

console.log(`Deployer ${deployer} on ${rpcUrl}\n`);
console.log(`guard wasm  ${guardHash}`);
console.log(`tUSD wasm   ${tusdHash}\n`);

await create('tUSD account', tusdId, [
  actionCreators.transfer(CREATE_BALANCE),
  actionCreators.deployContract(tusdWasm),
  actionCreators.functionCall('new', json({ owner_id: deployer, total_supply: '0' }), GAS, 0n),
]);
await create('Guard account', guardId, [
  actionCreators.transfer(CREATE_BALANCE),
  actionCreators.deployContract(guardWasm),
  actionCreators.functionCall('new', json({ tokens: [tusdId] }), GAS, 0n),
]);
await create('demo biller', billerId, [actionCreators.transfer(BILLER_BALANCE)]);

console.log('');
const billerBalanceBefore = await rpc
  .callView(tusdId, 'ft_balance_of', { account_id: billerId })
  .catch(() => '0');
if (BigInt(String(billerBalanceBefore ?? '0')) === 0n) {
  await send('mint tUSD to the biller', tusdId, [
    actionCreators.functionCall('mint', json({ account_id: billerId, amount: mintAmount }), GAS, 0n),
  ]);
} else {
  console.log(`• biller already holds tUSD (${String(billerBalanceBefore)}), not minting again`);
}
if (userAccount) {
  await send('mint tUSD to the Penny account', tusdId, [
    actionCreators.functionCall('mint', json({ account_id: userAccount, amount: mintAmount }), GAS, 0n),
  ]);
}

const guardTokens = (await rpc.callView(guardId, 'get_tokens', {})) as unknown;
const owner = (await rpc.callView(tusdId, 'get_owner', {})) as unknown;
const billerBalance = await rpc
  .callView(tusdId, 'ft_balance_of', { account_id: billerId })
  .catch(() => 'unknown');

console.log(`\nGuard tokens: ${JSON.stringify(guardTokens)}`);
console.log(`tUSD owner:   ${JSON.stringify(owner)}`);
console.log(`Biller tUSD:  ${JSON.stringify(billerBalance)}`);

console.log(`
Set these on the engine, then redeploy it:

NEAR_NETWORK=testnet
NEAR_RPC_URL=${rpcUrl}
DRY_RUN=0
NEAR_USDC_CONTRACT=${tusdId}
PENNY_GUARD_CONTRACT=${guardId}
PENNY_DEMO_BILLER_ACCOUNT=${billerId}

The demo biller and Penny accounts above now hold test dollars. To fund another
Penny account later (6 decimals, so 10000000 is $10.00):

  bun run deploy:testnet   # rerun with PENNY_USER_ACCOUNT_ID=<that account>

The Guard and tUSD accounts have no access keys: nobody can redeploy them.
`);
