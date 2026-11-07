/**
 * Live testnet $1 send: iMessage-shaped flow through the real engine.
 *
 * What it proves, on NEAR testnet with real keys:
 *   enroll (account created by the app account) -> Guard approval card ->
 *   device-signed NEP-366 delegate -> RealChain relay -> status poller ->
 *   settled, with the recipient balance checked on-chain.
 *
 * Required env (all testnet, never mainnet):
 *   NEAR_RPC_URL=https://rpc.testnet.near.org
 *   NEAR_APP_ACCOUNT_ID=<funded testnet account, e.g. you.testnet>
 *   NEAR_APP_PRIVATE_KEY=ed25519:<base58 secret>   (app/relayer signer)
 *   NEAR_RELAYER_ACCOUNT_ID=<same as app account>
 *   NEAR_RELAYER_PRIVATE_KEY=ed25519:<base58 secret>
 *   NEAR_RELAYER_PUBLIC_KEY=ed25519:<base58 public>
 *   PENNY_LIVE_CONFIRM=1   (explicit opt-in to spending testnet funds)
 *   RECIPIENT=<funded testnet account to receive 0.1 NEAR> (default: app account)
 *
 * PENNY_LIVE_SKIP_FACTORY=1 adds a temporary FullAccess "device" key to the
 * funded app/relayer account itself (the inverse of production, where device
 * keys live only on the user's own sub-account). The runner deletes that key
 * at the end. Testnet only; never point this at a funded mainnet account.
 *
 * Run from repo root: bun apps/engine/scripts/testnet-live.ts
 * The app account needs ~1 test NEAR (user account seed + gas). Get testnet
 * NEAR from the NEAR testnet faucet in your wallet, then re-run.
 */
import { generateKeyPairSync } from 'node:crypto';
import { buildSignedDelegateAction, chainAdapterFromEnv } from '@penny/chain';
import type { LanguageModel } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { createEngine, type Engine } from '../src/app.ts';
import { FakeEmbedder } from '../src/brain/memory.ts';
import { createRegistry, FakeMarket } from '../src/brain/tools.ts';
import { noopTracer } from '../src/brain/tracing.ts';
import { createPgliteDb } from '../src/db/client.ts';
import { createLogger } from '../src/lib/logger.ts';
import { FakeMessaging } from '../src/ports/messaging.ts';
import { RealChain } from '../src/ports/real-chain.ts';

const fail = (msg: string): never => {
  console.error(`STOP: ${msg}`);
  process.exit(1);
};
if (process.env.PENNY_LIVE_CONFIRM !== '1') fail('set PENNY_LIVE_CONFIRM=1 to spend testnet funds');
const rpcUrl = process.env.NEAR_RPC_URL ?? '';
if (!rpcUrl.includes('testnet')) fail('NEAR_RPC_URL must be a testnet endpoint');
for (const k of ['NEAR_APP_ACCOUNT_ID', 'NEAR_APP_PRIVATE_KEY', 'NEAR_RELAYER_PRIVATE_KEY']) {
  if (!process.env[k]) fail(`${k} is not set (funded testnet account required)`);
}

const offline = (): LanguageModel =>
  new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: 'text', text: 'live testnet runner' }],
      finishReason: { unified: 'stop', raw: undefined },
      usage: {
        inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 0, text: 0, reasoning: 0 },
      },
      warnings: [],
    }),
  }) as unknown as LanguageModel;

const dbh = await createPgliteDb();
let engineRef: Engine | null = null;
const adapter = chainAdapterFromEnv(process.env, {
  // Testnet proof only: sender == relayer account, so its own deposit is fine.
  // Raises the 0.01 NEAR relayer-drain default for this Guard-approved 0.1 NEAR.
  relayerMaxInnerDepositYocto: 10n ** 24n,
  verifyPolicy: { maxTotalDeposit: 10n ** 24n },
  resolveDeviceKey: async (signerId) => {
    if (!engineRef) return null;
    const user = await engineRef.repos.users.byAccountId(signerId);
    if (!user) return null;
    const device = await engineRef.repos.users.activeDevice(user.id);
    return device?.publicKey ?? null;
  },
});
const messaging = new FakeMessaging();
const engine = createEngine({
  db: dbh.db,
  chain: new RealChain(adapter),
  messaging,
  models: { router: offline(), chat: offline() },
  embedder: new FakeEmbedder(),
  market: new FakeMarket(),
  registry: createRegistry(),
  log: createLogger('info'),
  publicBaseUrl: 'https://penny.test',
  webhookSecret: undefined,
  limits: { perIpPerMin: 1000, perUserPerMin: 1000, maxBodyBytes: 65_536 },
  tracer: noopTracer,
});
engineRef = engine;

console.log('RPC height:', (await adapter.rpc.finalBlock()).height.toString());
const appId = process.env.NEAR_APP_ACCOUNT_ID ?? '';
if (!appId) fail('NEAR_APP_ACCOUNT_ID missing');
const appBefore = await adapter.rpc.viewAccount(appId);
if (!appBefore) fail(`app account ${appId} does not exist on testnet`);
console.log(`app account ${appId} balance: ${appBefore.amount} yocto`);

// 1) enroll a fresh device + user account (factory creates <slug>.<app>)
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const devicePub = (publicKey.export({ format: 'jwk' }) as { x: string }).x;
const deviceSecret = new Uint8Array(
  (privateKey.export({ format: 'jwk' }) as { d: string }).d
    ? Buffer.from((privateKey.export({ format: 'jwk' }) as { d: string }).d, 'base64url')
    : [],
);
const user = await engine.repos.users.findOrCreateByHandle('+15550100');
const skipFactory = process.env.PENNY_LIVE_SKIP_FACTORY === '1';
let tempDeviceKey: string | null = null;
if (skipFactory) {
  // An implicit 64-char account cannot parent subaccounts (child ids would
  // exceed NEAR's 64-char limit), so use the funded account itself as the
  // user account. The device key must be a SECOND key on the account: the
  // relayer tx and the delegate cannot share one key, because the outer tx
  // bumps that key's nonce and invalidates the delegate nonce.
  const { addKeyAction, buildTx, KeyPairSigner, signTx, toBase58 } = await import('@penny/chain');
  const nearPub = `ed25519:${toBase58(new Uint8Array(Buffer.from(devicePub, 'base64url')))}`;
  const keys = await adapter.rpc.viewAccessKeyList(appId);
  if (!keys.keys.some((k) => k.publicKey === nearPub)) {
    const signer = new KeyPairSigner(appId, process.env.NEAR_APP_PRIVATE_KEY ?? '');
    const appKey = await adapter.rpc.viewAccessKey(appId, signer.publicKey.toString());
    if (!appKey) fail('app access key not found');
    const built = buildTx({
      signerId: appId,
      signerPublicKey: signer.publicKey,
      receiverId: appId,
      nonce: appKey.nonce + 1n,
      actions: [addKeyAction(nearPub)],
      blockHash: appKey.blockHash,
    });
    const signed = await signTx(built, signer);
    await adapter.rpc.sendTx(signed.signedBase64, 'EXECUTED_OPTIMISTIC');
    console.log('added device key to app account:', nearPub);
    tempDeviceKey = nearPub;
  }
  await engine.repos.users.setAccount(user.id, 'live', appId, false);
  await engine.repos.users.addDevice(user.id, devicePub);
  console.log('skip-factory: user account is the funded app account', appId);
} else {
  const { code } = await engine.services.enroll.issue(user.id, '+15550100');
  const enrolled = await engine.services.enroll.enroll({
    enrollCode: code,
    publicKeyEd25519: devicePub,
  });
  console.log('enrolled user account:', enrolled.accountId, 'status:', enrolled.status);
  if (enrolled.status !== 'created')
    fail('account creation was dry-run; check DRY_RUN/keys (live relay must be on)');
}

// recipient: app account (funded, exists) receives 0.1 NEAR back
const recipient = process.env.RECIPIENT ?? appId;
const recipBefore = await adapter.rpc.viewAccount(recipient);
console.log(
  `recipient ${recipient} balance before: ${recipBefore?.amount ?? '0 (implicit, created by transfer)'}`,
);

// 2) Guard approval for a NEAR send (priced ~$1 at testnet prices; amount is NEAR)
const space = { spaceId: 'any;-;+15550100', userHandle: '+15550100' };
const created = await engine.services.approvals.createMoneyApproval({
  userId: user.id,
  bot: null,
  plan: { kind: 'send', asset: 'NEAR', amount: '0.1', to: recipient },
  space,
  nearUsdPriceMicros: 5_000_000n, // $5 sizing; engine has no live price feed yet
});
if (created.decision !== 'allow_with_approval') {
  fail(`Guard did not allow: ${created.decision} ${created.reasons.join(' ')}`);
}
console.log('approval created:', created.approvalId);
const dto = await engine.services.approvals.get(created.approvalId, created.cardToken);
console.log('card actions:', JSON.stringify(dto.actions), 'nonce:', dto.nonce);

// 3) device signs the delegate exactly like the iPhone would
const sda = buildSignedDelegateAction({
  secretKey: deviceSecret,
  senderId: dto.signerId,
  receiverId: dto.receiverId,
  actions: dto.actions as never,
  nonce: BigInt(dto.nonce),
  maxBlockHeight: BigInt(dto.maxBlockHeight),
});
const submitted = await engine.services.approvals.submit(created.approvalId, created.cardToken, {
  signedDelegateAction: sda,
});
const rowAfter = await engine.repos.approvals.get(created.approvalId);
console.log('submit ->', submitted.status, 'tx:', rowAfter?.txHash ?? '(none)');
if (rowAfter?.txHash) {
  console.log(`explorer: https://testnet.nearblocks.io/txns/${rowAfter.txHash}`);
}

// 4) status poller advances relayed -> settled
for (let i = 0; i < 20; i++) {
  const r = await engine.services.approvals.refreshRelayed();
  const s = await engine.services.approvals.status(created.approvalId, created.cardToken);
  console.log(
    `poll ${i}: status=${s.status} checked=${r.checked} settled=${r.settled} failed=${r.failed}`,
  );
  if (s.status === 'settled' || s.status === 'failed') break;
  await new Promise((r2) => setTimeout(r2, 3000));
}
const final = await engine.services.approvals.status(created.approvalId, created.cardToken);
const recipAfter = await adapter.rpc.viewAccount(recipient);
console.log(`recipient balance after: ${recipAfter?.amount}`);
console.log(
  final.status === 'settled'
    ? 'LIVE TESTNET SEND: SETTLED ✓'
    : `LIVE TESTNET SEND: ${final.status} ✗`,
);
// Remove the temporary FullAccess device key from the app/relayer account.
if (tempDeviceKey) {
  try {
    const { buildTx, deleteKeyAction, KeyPairSigner, signTx } = await import('@penny/chain');
    const signer = new KeyPairSigner(appId, process.env.NEAR_APP_PRIVATE_KEY ?? '');
    const appKey = await adapter.rpc.viewAccessKey(appId, signer.publicKey.toString());
    if (!appKey) throw new Error('app access key not found');
    const built = buildTx({
      signerId: appId,
      signerPublicKey: signer.publicKey,
      receiverId: appId,
      nonce: appKey.nonce + 1n,
      actions: [deleteKeyAction(tempDeviceKey)],
      blockHash: appKey.blockHash,
    });
    await adapter.rpc.sendTx((await signTx(built, signer)).signedBase64, 'EXECUTED_OPTIMISTIC');
    console.log('removed temporary device key:', tempDeviceKey);
  } catch (e) {
    console.error(`WARN: remove ${tempDeviceKey} from ${appId} by hand:`, (e as Error).message);
  }
}
await dbh.close();
process.exit(final.status === 'settled' ? 0 : 1);
