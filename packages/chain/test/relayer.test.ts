import { describe, expect, test } from 'bun:test';
import { decodeSignedTransaction, encodeTransaction, Transaction } from '@near-js/transactions';
import { sha256 } from '@noble/hashes/sha2.js';
import { KeyPairSigner } from '../src/near/keys.ts';
import { isLive, modeFromEnv } from '../src/near/mode.ts';
import { NearRelayer, RelayError } from '../src/near/relayer.ts';
import type { NearActionSpec } from '../src/near/types.ts';
import { fromBase64, toBase58 } from '../src/util/encoding.ts';
import { BLOCK_HASH, genKey, mockRpc, signDelegate, specToAction } from './helpers.ts';

const USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const HEIGHT = 223_000_000;
const ft: NearActionSpec = {
  type: 'FunctionCall',
  methodName: 'ft_transfer',
  args: { receiver_id: 'dep.near', amount: '5000000' },
  gas: '30000000000000',
  deposit: '1',
};

function setup(opts: { usdcBalance?: string; relayerAmount?: string; registered?: boolean } = {}) {
  const device = genKey();
  const relayerKey = genKey();
  const m = mockRpc({
    height: HEIGHT,
    blockHash: BLOCK_HASH,
    accounts: {
      'tobi.penny.near': {
        amount: '2000000000000000000000',
        keys: [{ public_key: device.near, nonce: 10, permission: 'FullAccess' }],
      },
      'relayer.penny.near': {
        amount: opts.relayerAmount ?? '5000000000000000000000000',
        keys: [{ public_key: relayerKey.near, nonce: 77, permission: 'FullAccess' }],
      },
    },
    views: {
      [USDC]: {
        ft_balance_of: () => opts.usdcBalance ?? '9000000',
        storage_balance_of: () =>
          opts.registered === false ? null : { total: '1250000000000000000000', available: '0' },
      },
    },
  });
  const sda = signDelegate({
    key: device,
    senderId: 'tobi.penny.near',
    receiverId: USDC,
    actions: [specToAction(ft)],
    nonce: 11n,
    maxBlockHeight: BigInt(HEIGHT + 100),
  });
  return {
    device,
    relayerKey,
    m,
    sda,
    signer: new KeyPairSigner('relayer.penny.near', relayerKey.nearSecret),
  };
}

describe('mode gate', () => {
  test('defaults dry; only exact DRY_RUN=0 + mainnet + key + call-level request is live', () => {
    expect(modeFromEnv({})).toEqual({ env: 'dev', dryRun: true, network: 'mainnet' });
    // testnet broadcasts with DRY_RUN=0 + signer; mainnet still needs both levels
    const tn = modeFromEnv({ NEAR_NETWORK: 'testnet', DRY_RUN: '0' });
    expect(tn.network).toBe('testnet');
    expect(isLive(tn, true, { dryRun: false, env: 'dev' })).toBe(true);
    expect(isLive(tn, true, { dryRun: true })).toBe(false);
    expect(isLive({ env: 'dev', dryRun: false, network: 'mainnet' }, true, { dryRun: false, env: 'dev' })).toBe(false);
    expect(modeFromEnv({ PENNY_ENV: 'mainnet', DRY_RUN: 'false' }).dryRun).toBe(true);
    const live = modeFromEnv({ PENNY_ENV: 'mainnet', DRY_RUN: '0' });
    expect(isLive(live, true, { dryRun: false, env: 'mainnet' })).toBe(true);
    expect(isLive(live, false, { dryRun: false, env: 'mainnet' })).toBe(false);
    expect(isLive(live, true, undefined)).toBe(false);
    expect(isLive(live, true, { dryRun: false })).toBe(false);
    expect(isLive({ env: 'dev', dryRun: false }, true, { dryRun: false, env: 'mainnet' })).toBe(
      false,
    );
  });
});

describe('NearRelayer', () => {
  test('dry run: returns would-be hash + preflight, never signs or broadcasts', async () => {
    const { m, sda, signer } = setup();
    const r = new NearRelayer({ rpc: m.rpc, relayerAccountId: 'relayer.penny.near', signer });
    const res = await r.relay(sda, { dryRun: false, env: 'mainnet' }); // config is still dry
    expect(res.mode).toBe('dry_run');
    expect(m.sent).toHaveLength(0);
    expect(m.calls.some((c) => c.method === 'send_tx')).toBe(false);
    expect(res.simulated.wouldSucceed).toBe(true);
    expect(res.relayerNonce).toBe('78');
    expect(res.receiverId).toBe(USDC);
    expect(res.senderId).toBe('tobi.penny.near');
  });

  test('dry run works with only a public key (no secret in process)', async () => {
    const { m, sda, relayerKey } = setup();
    const r = new NearRelayer({
      rpc: m.rpc,
      relayerAccountId: 'relayer.penny.near',
      relayerPublicKey: relayerKey.near,
    });
    const res = await r.relay(sda);
    expect(res.mode).toBe('dry_run');
    expect(res.txHash.length).toBeGreaterThan(40);
  });

  test('live: broadcasts exactly once; outer tx receiver = delegate sender; hash matches', async () => {
    const { m, sda, signer, relayerKey } = setup();
    const r = new NearRelayer({
      rpc: m.rpc,
      relayerAccountId: 'relayer.penny.near',
      signer,
      mode: { env: 'mainnet', dryRun: false },
    });
    const dry = await r.relay(sda);
    expect(dry.mode).toBe('dry_run');
    const res = await r.relay(sda, { dryRun: false, env: 'mainnet' });
    expect(res.mode).toBe('broadcast');
    expect(m.sent).toHaveLength(1);
    const stx = decodeSignedTransaction(fromBase64(m.sent[0] as string));
    expect(stx.transaction.signerId).toBe('relayer.penny.near');
    expect(stx.transaction.receiverId).toBe('tobi.penny.near');
    expect(stx.transaction.nonce).toBe(78n);
    expect(Object.keys(stx.transaction.actions[0] as object)).toContain('signedDelegate');
    const txBytes = encodeTransaction(new Transaction(stx.transaction));
    expect(res.txHash).toBe(toBase58(sha256(txBytes)));
    expect(res.txHash).toBe(dry.txHash);
    const sig = (stx.signature as unknown as { ed25519Signature: { data: number[] } })
      .ed25519Signature.data;
    expect(relayerKey.pk.verify(sha256(txBytes), Uint8Array.from(sig))).toBe(true);
  });

  test('live: refuses to broadcast when preflight fails', async () => {
    for (const o of [{ usdcBalance: '1' }, { relayerAmount: '1' }, { registered: false }]) {
      const { m, sda, signer } = setup(o);
      const r = new NearRelayer({
        rpc: m.rpc,
        relayerAccountId: 'relayer.penny.near',
        signer,
        mode: { env: 'mainnet', dryRun: false },
      });
      await expect(r.relay(sda, { dryRun: false, env: 'mainnet' })).rejects.toBeInstanceOf(
        RelayError,
      );
      expect(m.sent).toHaveLength(0);
    }
  });

  test('rejects mismatched signer config', () => {
    const { m, signer } = setup();
    expect(() => new NearRelayer({ rpc: m.rpc, relayerAccountId: 'other.near', signer })).toThrow(
      RelayError,
    );
    expect(() => new NearRelayer({ rpc: m.rpc, relayerAccountId: 'relayer.penny.near' })).toThrow(
      RelayError,
    );
  });

  test('KeyPairSigner never serialises its secret', () => {
    const { signer, relayerKey } = setup();
    const s = JSON.stringify(signer);
    expect(s).not.toContain(relayerKey.nearSecret.slice(8, 30));
    expect(s).toContain(relayerKey.near);
  });
});
