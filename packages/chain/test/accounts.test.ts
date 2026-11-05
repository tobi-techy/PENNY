import { describe, expect, test } from 'bun:test';
import { decodeSignedTransaction } from '@near-js/transactions';
import {
  AccountError,
  AccountFactory,
  buildCreateAccountActions,
  DEFAULT_INITIAL_BALANCE,
  planAgentAccounts,
  userAccountId,
  validateSlug,
} from '../src/near/accounts.ts';
import { KeyPairSigner, normalizeEd25519PublicKey } from '../src/near/keys.ts';
import { fromBase64, toBase64Url } from '../src/util/encoding.ts';
import { BLOCK_HASH, genKey, mockRpc } from './helpers.ts';

describe('slugs', () => {
  test('valid and invalid', () => {
    expect(userAccountId('tobi', 'penny.near')).toBe('tobi.penny.near');
    expect(validateSlug('a-b_c9')).toBe('a-b_c9');
    for (const bad of ['T', 'a', 'a.b', '-a', 'a-', 'a--b', 'x'.repeat(33), 'tobi!', ''])
      expect(() => validateSlug(bad)).toThrow(AccountError);
    for (const r of ['invest', 'guard', 'mail', 'finance', 'errand', 'relayer'])
      expect(() => validateSlug(r)).toThrow(/reserved/);
  });
});

describe('device keys', () => {
  test('accepts base64url (enroll wire form) and ed25519: form, rejects junk', () => {
    const k = genKey();
    expect(normalizeEd25519PublicKey(toBase64Url(k.raw))).toBe(k.near);
    expect(normalizeEd25519PublicKey(k.near)).toBe(k.near);
    expect(() => normalizeEd25519PublicKey('secp256k1:abc')).toThrow();
    expect(() => normalizeEd25519PublicKey(toBase64Url(new Uint8Array(31)))).toThrow();
  });
});

describe('createUserAccount', () => {
  test('actions: CreateAccount, Transfer(0.002 NEAR), AddKey(device, FullAccess) only', () => {
    const k = genKey();
    const a = buildCreateAccountActions(toBase64Url(k.raw));
    expect(a).toHaveLength(3);
    expect(a[0]?.createAccount).toBeDefined();
    expect(a[1]?.transfer?.deposit).toBe(DEFAULT_INITIAL_BALANCE);
    expect(DEFAULT_INITIAL_BALANCE).toBe(2_000_000_000_000_000_000_000n);
    expect(a[2]?.addKey?.publicKey.toString()).toBe(k.near);
    expect(a[2]?.addKey?.accessKey.permission.fullAccess).toBeDefined();
  });

  const app = genKey();
  const state = () =>
    mockRpc({
      height: 1000,
      blockHash: BLOCK_HASH,
      accounts: {
        'penny.near': {
          amount: '19000000000000000000000000',
          keys: [{ public_key: app.near, nonce: 5, permission: 'FullAccess' }],
        },
        'taken.penny.near': { amount: '1', keys: [] },
      },
    });

  test('dry run (default) plans 2 txs with hashes and never signs', async () => {
    const m = state();
    const f = new AccountFactory({
      rpc: m.rpc,
      appAccountId: 'penny.near',
      signer: new KeyPairSigner('penny.near', app.nearSecret),
    });
    const r = await f.createUserAccount('tobi', toBase64Url(genKey().raw), {
      dryRun: false,
      env: 'mainnet',
    });
    expect(r.mode).toBe('dry_run');
    expect(r.accountId).toBe('tobi.penny.near');
    expect(r.txs.map((t) => t.label)).toEqual(['create_account', 'usdc_storage']);
    expect(r.txs.every((t) => typeof t.txHash === 'string')).toBe(true);
    expect(m.sent).toHaveLength(0);
  });

  test('live mode sends create then storage, signed by app account', async () => {
    const m = state();
    const device = genKey();
    const f = new AccountFactory({
      rpc: m.rpc,
      appAccountId: 'penny.near',
      signer: new KeyPairSigner('penny.near', app.nearSecret),
      mode: { env: 'mainnet', dryRun: false },
    });
    const r = await f.createUserAccount('tobi', device.near, { dryRun: false, env: 'mainnet' });
    expect(r.mode).toBe('broadcast');
    expect(m.sent).toHaveLength(2);
    const t1 = decodeSignedTransaction(fromBase64(m.sent[0] as string)).transaction;
    expect(t1.signerId).toBe('penny.near');
    expect(t1.receiverId).toBe('tobi.penny.near');
    expect(t1.nonce).toBe(6n);
    const t2 = decodeSignedTransaction(fromBase64(m.sent[1] as string)).transaction;
    expect(t2.receiverId).toBe('17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1');
    expect(t2.nonce).toBe(7n);
  });

  test('refuses an existing account and bad keys', async () => {
    const f = new AccountFactory({
      rpc: state().rpc,
      appAccountId: 'penny.near',
      appPublicKey: app.near,
    });
    await expect(f.createUserAccount('taken', genKey().near)).rejects.toMatchObject({
      code: 'ACCOUNT_EXISTS',
    });
    await expect(f.createUserAccount('fresh', 'nope')).rejects.toMatchObject({
      code: 'INVALID_KEY',
    });
  });
});

describe('agent bootstrap plan', () => {
  test('dry plan for all five agents, public keys only', () => {
    const k = genKey();
    const plan = planAgentAccounts('penny.near', { invest: k.near });
    expect(plan.map((p) => p.accountId)).toEqual([
      'invest.penny.near',
      'guard.penny.near',
      'mail.penny.near',
      'finance.penny.near',
      'errand.penny.near',
    ]);
    expect(plan[0]?.fullAccessKey).toBe(k.near);
    expect(plan[1]?.fullAccessKey).toMatch(/GENERATE OFFLINE/);
    expect(plan[0]?.initialBalanceNear).toBe('0.01');
  });
});
