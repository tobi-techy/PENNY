import { describe, expect, test } from 'bun:test';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { ChainAdapter, chainAdapterFromEnv } from '../src/adapter.ts';
import { evmAddressFromSecp256k1 } from '../src/near/chainsig.ts';
import { fromBaseUnits, toBaseUnits, USDC_CONTRACT } from '../src/near/ft.ts';
import { KeyPairSigner } from '../src/near/keys.ts';
import type { NearActionSpec } from '../src/near/types.ts';
import { toBase58, toBase64Url } from '../src/util/encoding.ts';
import { BLOCK_HASH, genKey, mockRpc, signDelegate, specToAction } from './helpers.ts';

const HEIGHT = 5_000;
const ft: NearActionSpec = {
  type: 'FunctionCall',
  methodName: 'ft_transfer',
  args: { amount: '1000000', receiver_id: 'dep.near' },
  gas: '30000000000000',
  deposit: '1',
};

function world() {
  const device = genKey();
  const relayer = genKey();
  const m = mockRpc({
    height: HEIGHT,
    blockHash: BLOCK_HASH,
    accounts: {
      'tobi.penny.near': {
        amount: '3000000000000000000000',
        storage_usage: 182,
        keys: [{ public_key: device.near, nonce: 41, permission: 'FullAccess' }],
      },
      'penny.near': {
        amount: '19000000000000000000000000',
        keys: [{ public_key: relayer.near, nonce: 1, permission: 'FullAccess' }],
      },
    },
    views: {
      [USDC_CONTRACT]: {
        ft_balance_of: () => '12340000',
        storage_balance_of: () => ({ total: '1250000000000000000000', available: '0' }),
      },
    },
  });
  const adapter = new ChainAdapter({
    rpc: m.rpc,
    appAccountId: 'penny.near',
    relayerAccountId: 'penny.near',
    relayerSigner: new KeyPairSigner('penny.near', relayer.nearSecret),
    resolveDeviceKey: async () => toBase64Url(device.raw),
    now: () => new Date('2026-11-05T19:00:00Z'),
  });
  const approval = {
    id: 'apr_X',
    expiresAt: '2026-11-05T19:02:00Z',
    signerId: 'tobi.penny.near',
    receiverId: USDC_CONTRACT,
    actions: [ft],
    nonce: '42',
    maxBlockHeight: String(HEIGHT + 200),
  };
  const sda = signDelegate({
    key: device,
    senderId: 'tobi.penny.near',
    receiverId: USDC_CONTRACT,
    actions: [specToAction(ft)],
    nonce: 42n,
    maxBlockHeight: BigInt(HEIGHT + 200),
  });
  return { device, m, adapter, approval, sda };
}

describe('ChainAdapter (ChainPort)', () => {
  test('verify -> relay (dry) -> txStatus', async () => {
    const { m, adapter, approval, sda } = world();
    expect(await adapter.verifyDelegateAction(approval, sda)).toEqual({ ok: true });
    const r = await adapter.relay(approval, sda);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.dryRun).toBe(true);
      expect(await adapter.txStatus(r.txHash)).toBe('settled');
    }
    expect(m.sent).toHaveLength(0);
    expect(adapter.isLive).toBe(false);
  });
  test('relay re-verifies: tampered approval is refused', async () => {
    const { adapter, approval, sda } = world();
    const r = await adapter.relay({ ...approval, nonce: '43' }, sda);
    expect(r).toMatchObject({ ok: false });
  });
  test('expired approval and wrong device are refused', async () => {
    const { adapter, approval, sda } = world();
    expect(
      await adapter.verifyDelegateAction({ ...approval, expiresAt: '2026-11-05T18:59:59Z' }, sda),
    ).toMatchObject({ ok: false });
    const other = world();
    expect(await adapter.verifyDelegateAction(approval, other.sda)).toMatchObject({ ok: false });
  });
  test('prepareSigning returns nonce+1 and a short window', async () => {
    const { adapter, device } = world();
    expect(await adapter.prepareSigning('tobi.penny.near', toBase64Url(device.raw))).toEqual({
      nonce: '42',
      maxBlockHeight: String(HEIGHT + 200),
    });
  });
  test('createUserAccount is dry by default', async () => {
    const { adapter, m } = world();
    const r = await adapter.createUserAccount('ada', toBase64Url(genKey().raw));
    expect(r).toEqual({ ok: true, accountId: 'ada.penny.near', dryRun: true });
    expect(m.sent).toHaveLength(0);
    expect(await adapter.createUserAccount('tobi', toBase64Url(genKey().raw))).toMatchObject({
      ok: false,
    });
  });
  test('getBalances: bigint math, storage-aware available NEAR', async () => {
    const { adapter } = world();
    const b = await adapter.getBalances('tobi.penny.near');
    expect(b.usdc).toEqual({ raw: '12340000', display: '12.34', registered: true });
    expect(b.near.availableYocto).toBe(
      (3_000_000_000_000_000_000_000n - 182n * 10n ** 19n).toString(),
    );
    expect((await adapter.getBalances('nobody.penny.near')).exists).toBe(false);
  });
  test('fromEnv stays dry unless PENNY_ENV=mainnet and DRY_RUN=0', () => {
    const k = genKey();
    expect(chainAdapterFromEnv({ NEAR_RELAYER_PRIVATE_KEY: k.nearSecret }).isLive).toBe(false);
    expect(
      chainAdapterFromEnv({ PENNY_ENV: 'mainnet', NEAR_RELAYER_PRIVATE_KEY: k.nearSecret }).isLive,
    ).toBe(false);
    expect(chainAdapterFromEnv({ PENNY_ENV: 'mainnet', DRY_RUN: '0' }).isLive).toBe(false);
    expect(
      chainAdapterFromEnv({
        PENNY_ENV: 'mainnet',
        DRY_RUN: '0',
        NEAR_RELAYER_PRIVATE_KEY: k.nearSecret,
      }).isLive,
    ).toBe(true);
  });
  test('fromEnv testnet: live only when the RPC host is testnet', () => {
    const k = genKey();
    const base = { DRY_RUN: '0', NEAR_RELAYER_PRIVATE_KEY: k.nearSecret };
    expect(
      chainAdapterFromEnv({ ...base, NEAR_RPC_URL: 'https://rpc.testnet.near.org' }).isLive,
    ).toBe(true);
    // a stale NEAR_NETWORK label must not unlock the mainnet fallback RPC
    expect(chainAdapterFromEnv({ ...base, NEAR_NETWORK: 'testnet' }).isLive).toBe(false);
    expect(
      chainAdapterFromEnv({
        ...base,
        NEAR_NETWORK: 'testnet',
        NEAR_RPC_URL: 'https://rpc.mainnet.fastnear.com',
      }).isLive,
    ).toBe(false);
    // testnet is never live while dry
    expect(
      chainAdapterFromEnv({
        NEAR_RELAYER_PRIVATE_KEY: k.nearSecret,
        NEAR_RPC_URL: 'https://rpc.testnet.near.org',
      }).isLive,
    ).toBe(false);
  });
  test('a mode labelled testnet over a mainnet RPC is downgraded to mainnet rules', () => {
    const k = genKey();
    const adapter = new ChainAdapter({
      appAccountId: 'penny.near',
      relayerAccountId: 'penny.near',
      relayerSigner: new KeyPairSigner('penny.near', k.nearSecret),
      mode: { env: 'dev', dryRun: false, network: 'testnet' },
    });
    expect(adapter.mode.network).toBe('mainnet');
    expect(adapter.isLive).toBe(false);
  });
});

describe('amounts (bigint only)', () => {
  test('toBaseUnits / fromBaseUnits', () => {
    expect(toBaseUnits('50', 6)).toBe(50_000_000n);
    expect(toBaseUnits('0.000001', 6)).toBe(1n);
    expect(toBaseUnits('12.5', 6)).toBe(12_500_000n);
    expect(() => toBaseUnits('0.0000001', 6)).toThrow();
    expect(() => toBaseUnits('1e3', 6)).toThrow();
    expect(() => toBaseUnits('-1', 6)).toThrow();
    expect(fromBaseUnits(12_340_000n, 6)).toBe('12.34');
    expect(fromBaseUnits(2_000_000_000_000_000_000_000n, 24)).toBe('0.002');
  });
});

describe('chain signatures address derivation', () => {
  test('private key 1 -> 0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf', () => {
    const sk = new Uint8Array(32);
    sk[31] = 1;
    const uncompressed = secp256k1.getPublicKey(sk, false).slice(1);
    expect(evmAddressFromSecp256k1(`secp256k1:${toBase58(uncompressed)}`)).toBe(
      '0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf',
    );
  });
});
