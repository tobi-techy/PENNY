import { describe, expect, test } from 'bun:test';
import { decodeSignedTransaction } from '@near-js/transactions';
import { ChainAdapter } from '../src/adapter.ts';
import { USDC_CONTRACT } from '../src/near/ft.ts';
import { GuardContract, type GuardPolicyView } from '../src/near/guard.ts';
import { KeyPairSigner } from '../src/near/keys.ts';
import { fromBase64 } from '../src/util/encoding.ts';
import { BLOCK_HASH, genKey, mockRpc } from './helpers.ts';

const GUARD_ID = 'guard.penny.testnet';
const OWNER = 'tobi.penny.testnet';
const AGENT = 'invest.penny.testnet';

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
      [GUARD_ID]: {
        get_policy: () => ({
          owner_id: OWNER,
          agent_id: AGENT,
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
    guardContract: GUARD_ID,
  });
  return { m, adapter, rpc: m.rpc };
}

/** World with a full-access owner + agent key so owner/spend calls can broadcast on testnet. */
function liveWorld() {
  const owner = genKey();
  const agent = genKey();
  const policy: GuardPolicyView = {
    owner_id: OWNER,
    agent_id: AGENT,
    limits: [{ token: USDC_CONTRACT, per_tx_cap: '25000000', daily_cap: '50000000' }],
    allowlist: ['friend.near'],
    expires_at: null,
    paused: false,
    revoked: false,
    last_nonce: '3',
  };
  const m = mockRpc(
    {
      height: 5_000,
      blockHash: BLOCK_HASH,
      accounts: {
        [OWNER]: {
          amount: '1',
          keys: [{ public_key: owner.near, nonce: 10, permission: 'FullAccess' }],
        },
        [AGENT]: {
          amount: '1',
          keys: [{ public_key: agent.near, nonce: 7, permission: 'FullAccess' }],
        },
      },
      views: {
        [GUARD_ID]: {
          get_tokens: () => [USDC_CONTRACT, 'tusd.testnet'],
          get_policy: () => policy,
          get_agents: () => [policy],
          get_spent_today: () => '1000000',
          get_budget: () => '50000000',
          is_paused_all: () => false,
        },
      },
    },
    { url: 'https://rpc.testnet.near.org' },
  );
  const mode = { env: 'dev' as const, dryRun: false, network: 'testnet' as const };
  return { m, owner, agent, mode };
}

function callArgs(tx: ReturnType<typeof decodeSignedTransaction>['transaction'], index = 0) {
  const fc = tx.actions[index]?.functionCall;
  if (!fc) throw new Error(`action ${index} is not a function call`);
  return JSON.parse(Buffer.from(fc.args).toString());
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

describe('GuardContract client (shared contract)', () => {
  test('uses the configured shared contract id, never a per-user guard account', () => {
    const { rpc } = world();
    const guard = new GuardContract({ rpc, contractId: GUARD_ID });
    expect(guard.contractId).toBe(GUARD_ID);
    expect('forUser' in GuardContract).toBe(false);
    expect('addToken' in guard).toBe(false);
  });

  test('deployActions is the shared init call: new(tokens), no create/deploy', () => {
    const { rpc } = world();
    const guard = new GuardContract({ rpc, contractId: GUARD_ID });
    expect(() => guard.deployActions([])).toThrow('at least one allowed token');
    const actions = guard.deployActions([USDC_CONTRACT, 'tusd.testnet']);
    expect(actions).toHaveLength(1);
    const fc = actions[0]?.functionCall;
    expect(fc?.methodName).toBe('new');
    expect(fc?.deposit).toBe(0n);
    expect(JSON.parse(Buffer.from(fc?.args ?? new Uint8Array()).toString())).toEqual({
      tokens: [USDC_CONTRACT, 'tusd.testnet'],
    });
  });

  test('owner calls are owner-signed, carry 1 yocto, and name the agent', async () => {
    const { m, owner, mode } = liveWorld();
    const guard = new GuardContract({
      rpc: m.rpc,
      contractId: GUARD_ID,
      ownerSigner: new KeyPairSigner(OWNER, owner.nearSecret),
      mode,
    });
    const r = await guard.setPolicy(
      OWNER,
      AGENT,
      {
        limits: [{ token: USDC_CONTRACT, perTxCap: '25000000', dailyCap: '50000000' }],
        allowlist: ['friend.near'],
      },
      { dryRun: false },
    );
    expect(r.mode).toBe('broadcast');
    const tx = decodeSignedTransaction(fromBase64(m.sent[0] as string)).transaction;
    expect(tx.signerId).toBe(OWNER);
    expect(tx.receiverId).toBe(GUARD_ID);
    const fc = tx.actions[0]?.functionCall;
    expect(fc?.methodName).toBe('set_policy');
    expect(fc?.deposit).toBe(1n);
    expect(callArgs(tx)).toEqual({
      agent_id: AGENT,
      policy: {
        limits: [{ token: USDC_CONTRACT, per_tx_cap: '25000000', daily_cap: '50000000' }],
        allowlist: ['friend.near'],
      },
    });
  });

  test('owner signer must match the owner named in the call', () => {
    const { m, agent, mode } = liveWorld();
    const guard = new GuardContract({
      rpc: m.rpc,
      contractId: GUARD_ID,
      ownerSigner: new KeyPairSigner(AGENT, agent.nearSecret),
      mode,
    });
    expect(() =>
      guard.setPolicy(OWNER, AGENT, {
        limits: [{ token: USDC_CONTRACT, perTxCap: '1', dailyCap: '1' }],
      }),
    ).toThrow(/owner signer/);
    expect(m.sent).toHaveLength(0);
  });

  test('spend is agent-signed and carries owner_id', async () => {
    const { m, agent, mode } = liveWorld();
    const guard = new GuardContract({
      rpc: m.rpc,
      contractId: GUARD_ID,
      mode,
    });
    const r = await guard.spend(
      new KeyPairSigner(AGENT, agent.nearSecret),
      {
        ownerAccountId: OWNER,
        token: USDC_CONTRACT,
        recipient: 'friend.near',
        amountBaseUnits: '1000000',
        nonce: '4',
        memo: 'coffee',
      },
      { dryRun: false },
    );
    expect(r.mode).toBe('broadcast');
    const tx = decodeSignedTransaction(fromBase64(m.sent[0] as string)).transaction;
    expect(tx.signerId).toBe(AGENT);
    expect(tx.receiverId).toBe(GUARD_ID);
    const fc = tx.actions[0]?.functionCall;
    expect(fc?.methodName).toBe('spend');
    expect(fc?.deposit).toBe(0n);
    expect(callArgs(tx)).toEqual({
      owner_id: OWNER,
      token: USDC_CONTRACT,
      recipient: 'friend.near',
      amount: '1000000',
      memo: 'coffee',
      nonce: '4',
    });
  });

  test('views send owner_id and return contract shapes', async () => {
    const { m } = liveWorld();
    const guard = new GuardContract({ rpc: m.rpc, contractId: GUARD_ID });
    expect(await guard.getTokens()).toEqual([USDC_CONTRACT, 'tusd.testnet']);
    const policy = await guard.getPolicy(OWNER, AGENT);
    expect(policy?.owner_id).toBe(OWNER);
    expect(policy?.limits[0]?.per_tx_cap).toBe('25000000');
    expect((await guard.getAgents(OWNER))[0]?.agent_id).toBe(AGENT);
    expect(await guard.getSpentToday(OWNER, AGENT, USDC_CONTRACT)).toBe('1000000');
    expect(await guard.getBudget(OWNER, USDC_CONTRACT)).toBe('50000000');
    expect(await guard.isPausedAll(OWNER)).toBe(false);

    const viewArgs = (method: string) => {
      const call = m.calls.find(
        (c) =>
          c.method === 'query' &&
          (c.params as Record<string, unknown>).request_type === 'call_function' &&
          (c.params as Record<string, unknown>).method_name === method,
      );
      const params = call?.params as Record<string, unknown> | undefined;
      return JSON.parse(Buffer.from(String(params?.args_base64 ?? ''), 'base64').toString());
    };
    expect(viewArgs('get_policy')).toEqual({ owner_id: OWNER, agent_id: AGENT });
    expect(viewArgs('get_spent_today')).toEqual({
      owner_id: OWNER,
      agent_id: AGENT,
      token: USDC_CONTRACT,
    });
    expect(viewArgs('get_budget')).toEqual({ owner_id: OWNER, token: USDC_CONTRACT });
    expect(viewArgs('is_paused_all')).toEqual({ owner_id: OWNER });
    expect(viewArgs('get_agents')).toEqual({ owner_id: OWNER });
    expect(viewArgs('get_tokens')).toEqual({});
  });
});
