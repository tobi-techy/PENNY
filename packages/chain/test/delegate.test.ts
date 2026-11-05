import { describe, expect, test } from 'bun:test';
import { actionCreators } from '@near-js/transactions';
import { decodeSignedDelegateAction, verifySignedDelegateAction } from '../src/near/delegate.ts';
import type { ApprovalSigningFields, NearActionSpec } from '../src/near/types.ts';
import { fromBase64, toBase64, utf8 } from '../src/util/encoding.ts';
import {
  BLOCK_HASH,
  genKey,
  mockRpc,
  signDelegate,
  specToAction,
  type TestKey,
} from './helpers.ts';

const USDC = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const SENDER = 'tobi.penny.near';
const HEIGHT = 223_000_000;

const ftTransfer: NearActionSpec = {
  type: 'FunctionCall',
  methodName: 'ft_transfer',
  args: { receiver_id: 'abc123.near', amount: '50000000' },
  gas: '30000000000000',
  deposit: '1',
};

function approval(over: Partial<ApprovalSigningFields> = {}): ApprovalSigningFields {
  return {
    signerId: SENDER,
    receiverId: USDC,
    actions: [ftTransfer],
    nonce: '1001',
    maxBlockHeight: String(HEIGHT + 200),
    ...over,
  };
}

function chain(device: TestKey, opts: { nonce?: number; permission?: unknown } = {}) {
  return mockRpc({
    height: HEIGHT,
    blockHash: BLOCK_HASH,
    accounts: {
      [SENDER]: {
        amount: '2000000000000000000000',
        keys: [
          {
            public_key: device.near,
            nonce: opts.nonce ?? 1000,
            permission: opts.permission ?? 'FullAccess',
          },
        ],
      },
    },
  });
}

function sign(
  device: TestKey,
  over: {
    actions?: ReturnType<typeof specToAction>[];
    nonce?: bigint;
    maxBlockHeight?: bigint;
    senderId?: string;
    receiverId?: string;
    signWith?: TestKey;
  } = {},
) {
  return signDelegate({
    key: device,
    senderId: over.senderId ?? SENDER,
    receiverId: over.receiverId ?? USDC,
    actions: over.actions ?? [specToAction(ftTransfer)],
    nonce: over.nonce ?? 1001n,
    maxBlockHeight: over.maxBlockHeight ?? BigInt(HEIGHT + 200),
    ...(over.signWith ? { signWith: over.signWith } : {}),
  });
}

describe('decodeSignedDelegateAction', () => {
  test('round-trips a device-signed delegate', () => {
    const d = genKey();
    const sda = decodeSignedDelegateAction(sign(d));
    expect(sda.senderId).toBe(SENDER);
    expect(sda.receiverId).toBe(USDC);
    expect(sda.publicKey).toBe(d.near);
    expect(sda.nonce).toBe(1001n);
    expect(sda.actions[0]).toMatchObject({
      type: 'FunctionCall',
      methodName: 'ft_transfer',
      gas: 30_000_000_000_000n,
      deposit: 1n,
    });
    const a = sda.actions[0];
    if (a?.type !== 'FunctionCall') throw new Error('x');
    expect(utf8.decode(a.args)).toBe('{"amount":"50000000","receiver_id":"abc123.near"}');
    // NEP-461 prefix 2^30+366 is included in the signed hash: sanity check against near-js PublicKey.verify
    expect(d.pk.verify(sda.signedHash, sda.signature)).toBe(true);
  });
  test('rejects trailing bytes, garbage, url-safe base64', () => {
    const d = genKey();
    const bytes = fromBase64(sign(d));
    expect(() => decodeSignedDelegateAction(toBase64(new Uint8Array([...bytes, 0])))).toThrow();
    expect(() => decodeSignedDelegateAction('AAAA')).toThrow();
    expect(() => decodeSignedDelegateAction('not base64!')).toThrow();
    expect(() =>
      decodeSignedDelegateAction(toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_') + '-'),
    ).toThrow();
  });
});

describe('verifySignedDelegateAction', () => {
  test('accepts an exact match', async () => {
    const d = genKey();
    const r = await verifySignedDelegateAction(sign(d), approval(), chain(d).rpc, {
      expectedPublicKey: d.near,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.onChainNonce).toBe(1000n);
  });

  const cases: [string, (d: TestKey) => string, string, Partial<ApprovalSigningFields>?][] = [
    ['sender', (d) => sign(d, { senderId: 'evil.near' }), 'SENDER_MISMATCH'],
    ['receiver', (d) => sign(d, { receiverId: 'wrap.near' }), 'RECEIVER_MISMATCH'],
    [
      'method',
      (d) =>
        sign(d, { actions: [specToAction({ ...ftTransfer, methodName: 'ft_transfer_call' })] }),
      'ACTION_MISMATCH',
    ],
    [
      'args amount',
      (d) =>
        sign(d, {
          actions: [
            specToAction({
              ...ftTransfer,
              args: { receiver_id: 'abc123.near', amount: '50000001' },
            }),
          ],
        }),
      'ACTION_MISMATCH',
    ],
    [
      'args recipient',
      (d) =>
        sign(d, {
          actions: [
            specToAction({
              ...ftTransfer,
              args: { receiver_id: 'attacker.near', amount: '50000000' },
            }),
          ],
        }),
      'ACTION_MISMATCH',
    ],
    [
      'args non-canonical bytes (same JSON, different key order)',
      (d) =>
        sign(d, {
          actions: [
            specToAction(
              ftTransfer,
              utf8.encode('{"receiver_id":"abc123.near","amount":"50000000"}'),
            ),
          ],
        }),
      'ACTION_MISMATCH',
    ],
    [
      'args with whitespace',
      (d) =>
        sign(d, {
          actions: [
            specToAction(
              ftTransfer,
              utf8.encode('{"amount": "50000000","receiver_id":"abc123.near"}'),
            ),
          ],
        }),
      'ACTION_MISMATCH',
    ],
    [
      'gas',
      (d) => sign(d, { actions: [specToAction({ ...ftTransfer, gas: '30000000000001' })] }),
      'ACTION_MISMATCH',
    ],
    [
      'deposit',
      (d) => sign(d, { actions: [specToAction({ ...ftTransfer, deposit: '2' })] }),
      'ACTION_MISMATCH',
    ],
    [
      'extra action',
      (d) => sign(d, { actions: [specToAction(ftTransfer), specToAction(ftTransfer)] }),
      'ACTION_COUNT',
    ],
    [
      'smuggled AddKey',
      (d) =>
        sign(d, { actions: [actionCreators.addKey(genKey().pk, actionCreators.fullAccessKey())] }),
      'FORBIDDEN_ACTION',
    ],
    ['nonce mismatch', (d) => sign(d, { nonce: 1002n }), 'NONCE_MISMATCH'],
    [
      'max block height mismatch',
      (d) => sign(d, { maxBlockHeight: BigInt(HEIGHT + 201) }),
      'MAX_BLOCK_HEIGHT_MISMATCH',
    ],
    [
      'signed by a different key claiming the device key',
      (d) => sign(d, { signWith: genKey() }),
      'BAD_SIGNATURE',
    ],
  ];
  for (const [name, make, reason] of cases) {
    test(`rejects ${name}`, async () => {
      const d = genKey();
      const r = await verifySignedDelegateAction(make(d), approval(), chain(d).rpc);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe(reason as never);
    });
  }

  test('rejects a stale nonce (replay)', async () => {
    const d = genKey();
    const r = await verifySignedDelegateAction(sign(d), approval(), chain(d, { nonce: 1001 }).rpc);
    expect(r).toMatchObject({ ok: false, reason: 'NONCE_STALE' });
  });
  test('rejects expired maxBlockHeight', async () => {
    const d = genKey();
    const r = await verifySignedDelegateAction(
      sign(d, { maxBlockHeight: BigInt(HEIGHT) }),
      approval({ maxBlockHeight: String(HEIGHT) }),
      chain(d).rpc,
    );
    expect(r).toMatchObject({ ok: false, reason: 'EXPIRED' });
  });
  test('rejects maxBlockHeight too far ahead', async () => {
    const d = genKey();
    const far = BigInt(HEIGHT + 100_000);
    const r = await verifySignedDelegateAction(
      sign(d, { maxBlockHeight: far }),
      approval({ maxBlockHeight: far.toString() }),
      chain(d).rpc,
    );
    expect(r).toMatchObject({ ok: false, reason: 'MAX_BLOCK_HEIGHT_TOO_FAR' });
  });
  test('rejects nonce above block_height * 1e6', async () => {
    const d = genKey();
    const big = BigInt(HEIGHT) * 1_000_000n + 1n;
    const r = await verifySignedDelegateAction(
      sign(d, { nonce: big }),
      approval({ nonce: big.toString() }),
      chain(d).rpc,
    );
    expect(r).toMatchObject({ ok: false, reason: 'NONCE_TOO_LARGE' });
  });
  test('rejects a key that is not on chain', async () => {
    const d = genKey();
    const r = await verifySignedDelegateAction(sign(d), approval(), chain(genKey()).rpc);
    expect(r).toMatchObject({ ok: false, reason: 'KEY_NOT_ON_CHAIN' });
  });
  test('rejects a function-call (non full access) key', async () => {
    const d = genKey();
    const perm = { FunctionCall: { allowance: null, receiver_id: USDC, method_names: [] } };
    const r = await verifySignedDelegateAction(
      sign(d),
      approval(),
      chain(d, { permission: perm }).rpc,
    );
    expect(r).toMatchObject({ ok: false, reason: 'KEY_NOT_FULL_ACCESS' });
  });
  test('rejects a valid on-chain key that is not the enrolled device', async () => {
    const d = genKey();
    const r = await verifySignedDelegateAction(sign(d), approval(), chain(d).rpc, {
      expectedPublicKey: genKey().near,
    });
    expect(r).toMatchObject({ ok: false, reason: 'KEY_NOT_EXPECTED' });
  });
  test('caps gas and total deposit (relayer pays inner deposits)', async () => {
    const d = genKey();
    const bigGas: NearActionSpec = { ...ftTransfer, gas: '200000000000000' };
    const r1 = await verifySignedDelegateAction(
      sign(d, { actions: [specToAction(bigGas)] }),
      approval({ actions: [bigGas] }),
      chain(d).rpc,
    );
    expect(r1).toMatchObject({ ok: false, reason: 'GAS_CAP' });
    const drain: NearActionSpec = { type: 'Transfer', deposit: '5000000000000000000000000' };
    const r2 = await verifySignedDelegateAction(
      sign(d, { actions: [specToAction(drain)] }),
      approval({ actions: [drain] }),
      chain(d).rpc,
    );
    expect(r2).toMatchObject({ ok: false, reason: 'DEPOSIT_CAP' });
  });
  test('accepts a matching small Transfer', async () => {
    const d = genKey();
    const t: NearActionSpec = { type: 'Transfer', deposit: '1000' };
    const r = await verifySignedDelegateAction(
      sign(d, { actions: [specToAction(t)] }),
      approval({ actions: [t] }),
      chain(d).rpc,
    );
    expect(r.ok).toBe(true);
  });
  test('reports undecodable payloads', async () => {
    const d = genKey();
    const r = await verifySignedDelegateAction('AAAA', approval(), chain(d).rpc);
    expect(r).toMatchObject({ ok: false, reason: 'DECODE' });
  });
});
