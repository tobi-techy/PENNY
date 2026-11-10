import { describe, expect, test } from 'bun:test';
import { decodeSignedTransaction } from '@near-js/transactions';
import { ChainAdapter } from '../src/adapter.ts';
import { AccountFactory } from '../src/near/accounts.ts';
import { KeyPairSigner } from '../src/near/keys.ts';
import { fromBase64, toBase64Url } from '../src/util/encoding.ts';
import { BLOCK_HASH, genKey, mockRpc } from './helpers.ts';

const TUSD = 'tusd.testnet';

function testnetAdapter(live: boolean) {
  const app = genKey();
  const m = mockRpc(
    {
      height: 1_000,
      blockHash: BLOCK_HASH,
      accounts: {
        'penny.testnet': {
          amount: '19000000000000000000000000',
          keys: [{ public_key: app.near, nonce: 5, permission: 'FullAccess' }],
        },
      },
    },
    { url: 'https://rpc.testnet.near.org' },
  );
  const adapter = new ChainAdapter({
    rpc: m.rpc,
    appAccountId: 'penny.testnet',
    relayerAccountId: 'penny.testnet',
    appSigner: new KeyPairSigner('penny.testnet', app.nearSecret),
    mode: { env: 'dev', dryRun: !live, network: 'testnet' },
    usdcContract: TUSD,
  });
  return { m, adapter };
}

describe('testnet account creation', () => {
  test('dry plan registers the token it is given, not mainnet USDC', async () => {
    const app = genKey();
    const m = mockRpc({
      height: 1_000,
      blockHash: BLOCK_HASH,
      accounts: {
        'penny.testnet': {
          amount: '19000000000000000000000000',
          keys: [{ public_key: app.near, nonce: 5, permission: 'FullAccess' }],
        },
      },
    });
    const f = new AccountFactory({
      rpc: m.rpc,
      appAccountId: 'penny.testnet',
      signer: new KeyPairSigner('penny.testnet', app.nearSecret),
      usdcContract: TUSD,
    });
    const r = await f.createUserAccount('tobi', toBase64Url(genKey().raw));
    expect(r.mode).toBe('dry_run');
    const storage = r.txs.find((t) => t.label === 'usd_storage');
    expect(storage?.receiverId).toBe(TUSD);
    expect(m.sent).toHaveLength(0);
  });

  test('testnet adapter broadcasts storage_deposit to tUSD, not mainnet USDC', async () => {
    const { m, adapter } = testnetAdapter(true);
    const r = await adapter.createUserAccount('tobi', toBase64Url(genKey().raw));
    expect(r).toMatchObject({ ok: true, dryRun: false });
    expect(m.sent).toHaveLength(2);
    const storage = decodeSignedTransaction(fromBase64(m.sent[1] as string)).transaction;
    expect(storage.receiverId).toBe(TUSD);
    expect(storage.actions[0]?.functionCall?.methodName).toBe('storage_deposit');
    const args = JSON.parse(
      Buffer.from(storage.actions[0]?.functionCall?.args ?? new Uint8Array()).toString(),
    );
    expect(args).toEqual({ account_id: 'tobi.penny.testnet', registration_only: true });
  });
});
