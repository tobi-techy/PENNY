import { KeyType, PublicKey } from '@near-js/crypto';
import {
  type Action,
  actionCreators,
  buildDelegateAction,
  encodeDelegateAction,
  encodeSignedDelegate,
  Signature,
  SignedDelegate,
} from '@near-js/transactions';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { NearRpc } from '../src/near/rpc.ts';
import type { NearActionSpec } from '../src/near/types.ts';
import { canonicalBytes } from '../src/util/canonical.ts';
import { toBase58, toBase64 } from '../src/util/encoding.ts';
import type { FetchLike } from '../src/util/http.ts';

export interface TestKey {
  secret: Uint8Array;
  raw: Uint8Array;
  near: string;
  pk: PublicKey;
  /** NEAR secret key string ed25519:<base58(secret||pub)> */
  nearSecret: string;
}

export function genKey(): TestKey {
  const secret = ed25519.utils.randomSecretKey();
  const raw = ed25519.getPublicKey(secret);
  return {
    secret,
    raw,
    near: `ed25519:${toBase58(raw)}`,
    pk: new PublicKey({ keyType: KeyType.ED25519, data: raw }),
    nearSecret: `ed25519:${toBase58(new Uint8Array([...secret, ...raw]))}`,
  };
}

export function specToAction(a: NearActionSpec, argsBytes?: Uint8Array): Action {
  if (a.type === 'Transfer') return actionCreators.transfer(BigInt(a.deposit));
  return actionCreators.functionCall(
    a.methodName,
    argsBytes ?? canonicalBytes(a.args),
    BigInt(a.gas),
    BigInt(a.deposit),
  );
}

/** Build + sign a SignedDelegateAction the way the iPhone will. */
export function signDelegate(p: {
  key: TestKey;
  signWith?: TestKey;
  senderId: string;
  receiverId: string;
  actions: Action[];
  nonce: bigint;
  maxBlockHeight: bigint;
}): string {
  const da = buildDelegateAction({
    senderId: p.senderId,
    receiverId: p.receiverId,
    actions: p.actions,
    nonce: p.nonce,
    maxBlockHeight: p.maxBlockHeight,
    publicKey: p.key.pk,
  });
  const sig = ed25519.sign(sha256(encodeDelegateAction(da)), (p.signWith ?? p.key).secret);
  const sd = new SignedDelegate({
    delegateAction: da,
    signature: new Signature({ keyType: KeyType.ED25519, data: sig }),
  });
  return toBase64(encodeSignedDelegate(sd));
}

export interface ChainState {
  height: number;
  blockHash: string;
  gasPrice?: string;
  accounts: Record<
    string,
    {
      amount: string;
      storage_usage?: number;
      keys: { public_key: string; nonce: number; permission: unknown }[];
    }
  >;
  /** contract -> method -> (args) => json */
  views?: Record<string, Record<string, (args: Record<string, unknown>) => unknown>>;
}

export interface MockRpc {
  rpc: NearRpc;
  calls: { method: string; params: unknown }[];
  sent: string[];
}

export function mockRpc(
  state: ChainState,
  opts: { sendTxResult?: unknown; url?: string } = {},
): MockRpc {
  const calls: { method: string; params: unknown }[] = [];
  const sent: string[] = [];
  const reply = (id: string, body: object) =>
    new Response(JSON.stringify({ jsonrpc: '2.0', id, ...body }), { status: 200 });
  const f: FetchLike = async (_url, init) => {
    const req = JSON.parse(String(init?.body)) as {
      id: string;
      method: string;
      params: Record<string, unknown>;
    };
    calls.push({ method: req.method, params: req.params });
    const meta = { block_height: state.height, block_hash: state.blockHash };
    if (req.method === 'block')
      return reply(req.id, { result: { header: { height: state.height, hash: state.blockHash } } });
    if (req.method === 'gas_price')
      return reply(req.id, { result: { gas_price: state.gasPrice ?? '100000000' } });
    if (req.method === 'send_tx') {
      sent.push(String(req.params.signed_tx_base64));
      return reply(req.id, {
        result: opts.sendTxResult ?? {
          status: { SuccessValue: '' },
          final_execution_status: 'EXECUTED_OPTIMISTIC',
        },
      });
    }
    if (req.method === 'tx')
      return reply(req.id, {
        result: { status: { SuccessValue: '' }, final_execution_status: 'FINAL' },
      });
    if (req.method !== 'query')
      return reply(req.id, {
        error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_METHOD' }, message: 'unknown' },
      });
    const p = req.params;
    const acct = state.accounts[String(p.account_id)];
    switch (p.request_type) {
      case 'view_account':
        if (!acct)
          return reply(req.id, {
            error: {
              name: 'HANDLER_ERROR',
              cause: { name: 'UNKNOWN_ACCOUNT', info: {} },
              message: 'Server error',
            },
          });
        return reply(req.id, {
          result: {
            amount: acct.amount,
            locked: '0',
            code_hash: '11111111111111111111111111111111',
            storage_usage: acct.storage_usage ?? 182,
            storage_paid_at: 0,
            ...meta,
          },
        });
      case 'view_access_key_list':
        if (!acct)
          return reply(req.id, {
            error: {
              name: 'HANDLER_ERROR',
              cause: { name: 'UNKNOWN_ACCOUNT', info: {} },
              message: 'Server error',
            },
          });
        return reply(req.id, {
          result: {
            keys: acct.keys.map((k) => ({
              public_key: k.public_key,
              access_key: { nonce: k.nonce, permission: k.permission },
            })),
            ...meta,
          },
        });
      case 'view_access_key': {
        const k = acct?.keys.find((x) => x.public_key === p.public_key);
        if (!k)
          return reply(req.id, {
            result: {
              error: `access key ${String(p.public_key)} does not exist while viewing`,
              logs: [],
              ...meta,
            },
          });
        return reply(req.id, { result: { nonce: k.nonce, permission: k.permission, ...meta } });
      }
      case 'call_function': {
        const args = JSON.parse(Buffer.from(String(p.args_base64), 'base64').toString()) as Record<
          string,
          unknown
        >;
        const fn = state.views?.[String(p.account_id)]?.[String(p.method_name)];
        if (!fn)
          return reply(req.id, {
            result: {
              error: 'wasm execution failed with error: MethodNotFound',
              logs: [],
              ...meta,
            },
          });
        const out = Buffer.from(JSON.stringify(fn(args)));
        return reply(req.id, { result: { result: [...out], logs: [], ...meta } });
      }
    }
    return reply(req.id, {
      error: { name: 'HANDLER_ERROR', cause: { name: 'BAD' }, message: 'bad request' },
    });
  };
  return { rpc: new NearRpc({ url: opts.url ?? 'http://mock.rpc', fetch: f }), calls, sent };
}

export const BLOCK_HASH = toBase58(new Uint8Array(32).fill(7));
