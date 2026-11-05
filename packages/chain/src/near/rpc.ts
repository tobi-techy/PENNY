import { z } from 'zod';
import { toBase64 } from '../util/encoding.ts';
import { type FetchLike, fetchJson } from '../util/http.ts';

export const MAINNET_RPC_URL = 'https://rpc.mainnet.fastnear.com';

export class RpcError extends Error {
  override name = 'RpcError';
  constructor(
    message: string,
    readonly cause_name: string | undefined,
    readonly data: unknown,
  ) {
    super(message);
  }
}

/** JSON numbers above 2^53 would silently lose precision. Fail closed. */
const SafeInt = z
  .number()
  .int()
  .nonnegative()
  .refine((n) => Number.isSafeInteger(n), 'unsafe integer');
const BigIntish = z.union([SafeInt, z.string().regex(/^\d+$/)]).transform((v) => BigInt(v));

const RpcEnvelope = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]),
  result: z.unknown().optional(),
  error: z
    .object({
      name: z.string().optional(),
      cause: z.object({ name: z.string(), info: z.unknown().optional() }).optional(),
      message: z.string().optional(),
      data: z.unknown().optional(),
    })
    .optional(),
});

const FunctionCallPermissionRaw = z.object({
  FunctionCall: z.object({
    allowance: z.string().nullable(),
    receiver_id: z.string(),
    method_names: z.array(z.string()),
  }),
});
const PermissionRaw = z.union([z.literal('FullAccess'), FunctionCallPermissionRaw]);
export type AccessKeyPermission = z.infer<typeof PermissionRaw>;

const AccessKeyView = z.object({
  nonce: BigIntish,
  permission: PermissionRaw,
  block_hash: z.string(),
  block_height: SafeInt,
});
const AccessKeyListView = z.object({
  keys: z.array(
    z.object({
      public_key: z.string(),
      access_key: z.object({ nonce: BigIntish, permission: PermissionRaw }),
    }),
  ),
  block_hash: z.string(),
  block_height: SafeInt,
});
const AccountView = z.object({
  amount: z.string().regex(/^\d+$/),
  locked: z.string().regex(/^\d+$/),
  code_hash: z.string(),
  storage_usage: SafeInt,
  block_height: SafeInt,
  block_hash: z.string(),
});
const CallResult = z.object({
  result: z.array(z.number().int().min(0).max(255)),
  block_height: SafeInt,
});
const QueryErrorResult = z.object({ error: z.string() });
const BlockView = z.object({
  header: z.object({ height: SafeInt, hash: z.string(), timestamp_nanosec: z.string().optional() }),
});

export interface AccessKeyInfo {
  publicKey: string;
  nonce: bigint;
  permission: AccessKeyPermission;
}

export interface AccountInfo {
  amount: bigint;
  locked: bigint;
  codeHash: string;
  storageUsage: number;
  blockHeight: bigint;
}

export interface NearRpcOptions {
  url?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  /** e.g. an x-api-key for a paid RPC. Never logged. */
  headers?: Record<string, string>;
}

/** Minimal, zod-validated NEAR JSON-RPC client. Read calls + send_tx. */
export class NearRpc {
  readonly url: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly headers: Record<string, string>;
  private seq = 0;

  constructor(opts: NearRpcOptions = {}) {
    this.url = opts.url ?? MAINNET_RPC_URL;
    this.fetchImpl = opts.fetch ?? ((i, init) => fetch(i, init));
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.headers = opts.headers ?? {};
  }

  async raw(method: string, params: unknown): Promise<unknown> {
    const env = await fetchJson(this.fetchImpl, this.url, RpcEnvelope, {
      method: 'POST',
      body: { jsonrpc: '2.0', id: `penny-${++this.seq}`, method, params },
      headers: this.headers,
      timeoutMs: this.timeoutMs,
    });
    if (env.error) {
      throw new RpcError(
        env.error.message ?? 'RPC error',
        env.error.cause?.name ?? env.error.name,
        env.error.data,
      );
    }
    return env.result;
  }

  private async query<S extends z.ZodType>(
    params: Record<string, unknown>,
    schema: S,
  ): Promise<z.infer<S>> {
    const result = await this.raw('query', { finality: 'final', ...params });
    const asErr = QueryErrorResult.safeParse(result);
    if (asErr.success)
      throw new RpcError(asErr.data.error, inferQueryCause(asErr.data.error), result);
    const parsed = schema.safeParse(result);
    if (!parsed.success)
      throw new RpcError('unexpected query result shape', 'SCHEMA', parsed.error.issues);
    return parsed.data;
  }

  /** null when the account does not exist. */
  async viewAccount(accountId: string): Promise<AccountInfo | null> {
    try {
      const r = await this.query(
        { request_type: 'view_account', account_id: accountId },
        AccountView,
      );
      return {
        amount: BigInt(r.amount),
        locked: BigInt(r.locked),
        codeHash: r.code_hash,
        storageUsage: r.storage_usage,
        blockHeight: BigInt(r.block_height),
      };
    } catch (e) {
      if (e instanceof RpcError && e.cause_name === 'UNKNOWN_ACCOUNT') return null;
      throw e;
    }
  }

  async viewAccessKeyList(
    accountId: string,
  ): Promise<{ keys: AccessKeyInfo[]; blockHeight: bigint }> {
    const r = await this.query(
      { request_type: 'view_access_key_list', account_id: accountId },
      AccessKeyListView,
    );
    return {
      keys: r.keys.map((k) => ({
        publicKey: k.public_key,
        nonce: k.access_key.nonce,
        permission: k.access_key.permission,
      })),
      blockHeight: BigInt(r.block_height),
    };
  }

  /** null when the key does not exist on the account. */
  async viewAccessKey(
    accountId: string,
    publicKey: string,
  ): Promise<{
    nonce: bigint;
    permission: AccessKeyPermission;
    blockHash: string;
    blockHeight: bigint;
  } | null> {
    try {
      const r = await this.query(
        { request_type: 'view_access_key', account_id: accountId, public_key: publicKey },
        AccessKeyView,
      );
      return {
        nonce: r.nonce,
        permission: r.permission,
        blockHash: r.block_hash,
        blockHeight: BigInt(r.block_height),
      };
    } catch (e) {
      if (e instanceof RpcError && e.cause_name === 'UNKNOWN_ACCESS_KEY') return null;
      throw e;
    }
  }

  /** View function call; returns parsed JSON. */
  async callView(
    contractId: string,
    methodName: string,
    args: Record<string, unknown> = {},
  ): Promise<unknown> {
    const r = await this.query(
      {
        request_type: 'call_function',
        account_id: contractId,
        method_name: methodName,
        args_base64: toBase64(new TextEncoder().encode(JSON.stringify(args))),
      },
      CallResult,
    );
    const text = new TextDecoder().decode(Uint8Array.from(r.result));
    return text.length === 0 ? null : JSON.parse(text);
  }

  /** Current gas price in yoctoNEAR per gas unit. */
  async gasPrice(): Promise<bigint> {
    const r = z
      .object({ gas_price: z.string().regex(/^\d+$/) })
      .parse(await this.raw('gas_price', [null]));
    return BigInt(r.gas_price);
  }

  async finalBlock(): Promise<{ height: bigint; hash: string }> {
    const r = BlockView.parse(await this.raw('block', { finality: 'final' }));
    return { height: BigInt(r.header.height), hash: r.header.hash };
  }

  /**
   * Broadcast a signed transaction. Only NearRelayer / AccountFactory call this,
   * and only behind their live-mode gate.
   */
  async sendTx(
    signedTxBase64: string,
    waitUntil: 'NONE' | 'INCLUDED_FINAL' | 'EXECUTED_OPTIMISTIC' | 'FINAL' = 'EXECUTED_OPTIMISTIC',
  ): Promise<unknown> {
    return this.raw('send_tx', { signed_tx_base64: signedTxBase64, wait_until: waitUntil });
  }
}

function inferQueryCause(msg: string): string | undefined {
  if (/access key .* does not exist/i.test(msg)) return 'UNKNOWN_ACCESS_KEY';
  if (/account .* does not exist/i.test(msg)) return 'UNKNOWN_ACCOUNT';
  if (/MethodNotFound|CodeDoesNotExist|wasm execution failed/i.test(msg))
    return 'CONTRACT_EXECUTION_ERROR';
  return undefined;
}
