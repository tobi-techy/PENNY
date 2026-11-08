import { describe, expect, test } from 'bun:test';
import { ChainAdapter } from '../src/adapter.ts';
import { USDC_CONTRACT } from '../src/near/ft.ts';
import { GuardContract, guardContractId } from '../src/near/guard.ts';
import { KeyPairSigner } from '../src/near/keys.ts';
import { BLOCK_HASH, genKey, mockRpc } from './helpers.ts';

function world(storage: unknown = { total: '1250000000000000000000', available: '0' }) {
  const relayer = genKey();
  const m = mockRpc({
    height: 5_000,
    blockHash: BLOCK_HASH,
    accounts: {
      'penny.near': {
        amount: '19000000000000000000000000',
        keys: [{ public_key: relayer.near, nonce: 1, permission: 'FullAccess' }],
      },
    },
    views: {
      [USDC_CONTRACT]: { storage_balance_of: () => storage },
      'guard.tobi.penny.near': {
        get_policy: () => ({
          agent_id: 'invest.tobi.penny.near',
          limits: [{ token: USDC_CONTRACT, per_tx_cap: '25000000', daily_cap: '50000000' }],
          allowlist: [],
          expires_at: null,
          paused: false,
          revoked: false,
          last_nonce: '0',
        }),
        get_spent_today: () => '1000000',
      },
    },
  });
  const adapter = new ChainAdapter({
    rpc: m.rpc,
    appAccountId: 'penny.near',
    relayerAccountId: 'penny.near',
    relayerSigner: new KeyPairSigner('penny.near', relayer.nearSecret),
    resolveDeviceKey: async () => null,
  });
  return { m, adapter, rpc: m.rpc };
}

describe('buildActions (real money path, deterministic)', () => {
  test('NEAR send is a plain Transfer in yocto', async () => {
    const { adapter } = world();
    const r = await adapter.buildActions(
      { kind: 'send', asset: 'NEAR', amount: '0.5', to: 'friend.near' },
      'tobi.penny.near',
    );
    expect(r).toEqual({
      receiverId: 'friend.near',
      actions: [{ type: 'Transfer', deposit: '500000000000000000000000' }],
    });
  });

  test('USDC send to registered receiver is one ft_transfer', async () => {
    const { adapter } = world();
    const r = await adapter.buildActions(
      { kind: 'send', asset: 'USDC', amount: '25', to: 'friend.near' },
      'tobi.penny.near',
    );
    expect(r.receiverId).toBe(USDC_CONTRACT);
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]).toMatchObject({ methodName: 'ft_transfer', deposit: '1' });
  });

  test('USDC send to unregistered receiver prepends storage_deposit', async () => {
    const { adapter } = world(null);
    const r = await adapter.buildActions(
      { kind: 'pay_bill', payee: 'newbiller.near', amount: '10', asset: 'USDC' },
      'tobi.penny.near',
    );
    expect(r.actions.map((a) => (a.type === 'FunctionCall' ? a.methodName : a.type))).toEqual([
      'storage_deposit',
      'ft_transfer',
    ]);
  });

  test('invest without a cached quote fails closed', async () => {
    const { adapter } = world();
    await expect(
      adapter.buildActions(
        { kind: 'invest', amountUsd: '25', portfolioId: 'p1', quoteId: 'q_missing' },
        'tobi.penny.near',
      ),
    ).rejects.toThrow('unknown quote');
  });
});

describe('GuardContract client', () => {
  test('contract id, deploy validation, dry owner call, views', async () => {
    const { rpc } = world();
    expect(guardContractId('tobi.penny.near')).toBe('guard.tobi.penny.near');
    const owner = genKey();
    const guard = GuardContract.forUser(
      rpc,
      'tobi.penny.near',
      new KeyPairSigner('tobi.penny.near', owner.nearSecret),
    );
    expect(() => guard.deployActions(new Uint8Array([0]), [])).toThrow('at least one allowed token');
    const dry = await guard.setPolicy('invest.tobi.penny.near', {
      limits: [{ token: USDC_CONTRACT, perTxCap: '25000000', dailyCap: '50000000' }],
    });
    expect(dry.mode).toBe('dry_run');
    const policy = await guard.getPolicy('invest.tobi.penny.near');
    expect(policy?.limits[0]?.per_tx_cap).toBe('25000000');
    expect(await guard.getSpentToday('invest.tobi.penny.near', USDC_CONTRACT)).toBe('1000000');
  });
});
