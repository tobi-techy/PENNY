import { actionCreators, SCHEMA, type SignedDelegate } from '@near-js/transactions';
import { deserialize } from 'borsh';
import {
  DEFAULT_POLICY,
  type DecodedSignedDelegate,
  decodeSignedDelegateAction,
} from './delegate.ts';
import { ftBalanceOf, storageBalanceOf } from './ft.ts';
import { publicKeyFromString, type TxSigner } from './keys.ts';
import { type ChainMode, DEFAULT_MODE, isLive, type LiveRequest } from './mode.ts';
import type { NearRpc } from './rpc.ts';
import { buildTx, signTx } from './tx.ts';
import { TGAS } from './types.ts';

export interface PreflightCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface RelayResult {
  mode: 'dry_run' | 'broadcast';
  /** Hash of the relayer transaction (base58). In dry run: the hash it WOULD have; nothing was signed. */
  txHash: string;
  relayerId: string;
  senderId: string;
  receiverId: string;
  relayerNonce: string;
  blockHash: string;
  /**
   * NEAR has no transaction dry-run RPC. This is a deterministic preflight against
   * current chain state (keys, nonces, block height, balances, token registration),
   * not an execution trace.
   */
  simulated: { wouldSucceed: boolean; checks: PreflightCheck[]; estimatedRelayerCostYocto: string };
  outcome?: unknown;
}

export class RelayError extends Error {
  override name = 'RelayError';
  constructor(
    message: string,
    readonly checks?: PreflightCheck[],
  ) {
    super(message);
  }
}

export interface RelayerOptions {
  rpc: NearRpc;
  relayerAccountId: string;
  /** Needed to build the tx (nonce lookup) even in dry run. Defaults to signer.publicKey. */
  relayerPublicKey?: string;
  /** Only required for live broadcast. Dry runs never sign. */
  signer?: TxSigner;
  mode?: ChainMode;
  /**
   * Relayer pays inner deposits (docs.near.org meta-tx). Cap used when a relay call
   * does not carry its own per-approval limit. Default 0.01 NEAR.
   */
  maxInnerDepositYocto?: bigint;
  /**
   * Env hard ceiling (PENNY_RELAYER_MAX_DEPOSIT_NEAR). A per-approval limit above this
   * is refused. Default 1 NEAR.
   */
  hardCeilingYocto?: bigint;
  maxInnerGas?: bigint;
}

export const DEFAULT_RELAYER_HARD_CEILING = 10n ** 24n;

/** Per-call limits. maxInnerDepositYocto comes from the approved amount (sum of approved deposits). */
export interface RelayLimits {
  maxInnerDepositYocto?: bigint;
}

/** Overhead for the outer tx + delegate unpacking, generous upper bound for cost estimate. */
const OUTER_GAS_OVERHEAD = 10n * TGAS;

export class NearRelayer {
  private readonly mode: ChainMode;
  private readonly relayerPublicKey: string;

  constructor(private readonly o: RelayerOptions) {
    this.mode = o.mode ?? DEFAULT_MODE;
    const pk = o.relayerPublicKey ?? o.signer?.publicKey.toString();
    if (!pk) throw new RelayError('relayerPublicKey or signer required');
    if (o.signer && o.signer.publicKey.toString() !== pk)
      throw new RelayError('signer key does not match relayerPublicKey');
    if (o.signer && o.signer.accountId !== o.relayerAccountId)
      throw new RelayError('signer account does not match relayerAccountId');
    this.relayerPublicKey = pk;
  }

  /**
   * Wrap a SignedDelegateAction in a relayer-signed tx (receiver = delegate sender, NEP-366).
   * Broadcasts ONLY if config is live (PENNY_ENV=mainnet, DRY_RUN=0, signer present)
   * AND opts is exactly { dryRun: false, env: 'mainnet' }. Otherwise returns the would-be tx hash + preflight.
   * Callers must have run verifySignedDelegateAction against the approval first.
   */
  async relay(sdaB64: string, opts?: LiveRequest, limits: RelayLimits = {}): Promise<RelayResult> {
    const sda = decodeSignedDelegateAction(sdaB64);
    const live = isLive(this.mode, this.o.signer !== undefined, opts);

    const [relayerKey, preflight] = await Promise.all([
      this.o.rpc.viewAccessKey(this.o.relayerAccountId, this.relayerPublicKey),
      this.preflight(sda, limits),
    ]);
    if (!relayerKey) throw new RelayError(`relayer key not found on ${this.o.relayerAccountId}`);

    const signedDelegate = deserialize(
      SCHEMA.SignedDelegate,
      sda.bytes,
    ) as unknown as SignedDelegate;
    const built = buildTx({
      signerId: this.o.relayerAccountId,
      signerPublicKey: publicKeyFromString(this.relayerPublicKey),
      receiverId: sda.senderId,
      nonce: relayerKey.nonce + 1n,
      actions: [actionCreators.signedDelegate(signedDelegate)],
      blockHash: relayerKey.blockHash,
    });

    const base: RelayResult = {
      mode: 'dry_run',
      txHash: built.hash,
      relayerId: this.o.relayerAccountId,
      senderId: sda.senderId,
      receiverId: sda.receiverId,
      relayerNonce: (relayerKey.nonce + 1n).toString(),
      blockHash: relayerKey.blockHash,
      simulated: preflight,
    };
    if (!live) return base;

    if (!preflight.wouldSucceed)
      throw new RelayError('preflight failed; refusing to broadcast', preflight.checks);
    const signer = this.o.signer;
    if (!signer) throw new RelayError('no signer');
    const signed = await signTx(built, signer);
    const outcome = await this.o.rpc.sendTx(signed.signedBase64, 'EXECUTED_OPTIMISTIC');
    return { ...base, mode: 'broadcast', txHash: signed.hash, outcome };
  }

  /** The deposit cap a relay call runs under: per-approval when given (never above the hard ceiling). */
  depositCap(limits: RelayLimits = {}): { cap: bigint; ceiling: bigint; source: string } {
    const ceiling = this.o.hardCeilingYocto ?? DEFAULT_RELAYER_HARD_CEILING;
    if (limits.maxInnerDepositYocto !== undefined)
      return { cap: limits.maxInnerDepositYocto, ceiling, source: 'approved amount' };
    return {
      cap: this.o.maxInnerDepositYocto ?? DEFAULT_POLICY.maxTotalDeposit,
      ceiling,
      source: 'default',
    };
  }

  private async preflight(
    sda: DecodedSignedDelegate,
    limits: RelayLimits = {},
  ): Promise<RelayResult['simulated']> {
    const checks: PreflightCheck[] = [];
    const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
    const { cap: maxDeposit, ceiling, source } = this.depositCap(limits);
    if (limits.maxInnerDepositYocto !== undefined)
      add(
        'per_approval_within_ceiling',
        limits.maxInnerDepositYocto <= ceiling,
        `${limits.maxInnerDepositYocto} <= ${ceiling} (env hard ceiling)`,
      );
    const maxGas = this.o.maxInnerGas ?? DEFAULT_POLICY.maxTotalGas;

    let innerGas = 0n;
    let innerDeposit = 0n;
    for (const a of sda.actions) {
      if (a.type === 'Other') add('allowed_actions', false, `forbidden inner action ${a.kind}`);
      else {
        innerDeposit += a.deposit;
        if (a.type === 'FunctionCall') innerGas += a.gas;
      }
    }
    if (!checks.some((c) => c.name === 'allowed_actions'))
      add('allowed_actions', true, 'FunctionCall/Transfer only');
    add('inner_gas_cap', innerGas <= maxGas, `${innerGas} <= ${maxGas}`);
    add(
      'inner_deposit_cap',
      innerDeposit <= maxDeposit,
      `${innerDeposit} <= ${maxDeposit} (${source}; relayer pays inner deposits)`,
    );

    const [keys, block, gasPrice, relayerAcct] = await Promise.all([
      this.o.rpc.viewAccessKeyList(sda.senderId).catch(() => null),
      this.o.rpc.finalBlock(),
      this.o.rpc.gasPrice(),
      this.o.rpc.viewAccount(this.o.relayerAccountId),
    ]);
    const key = keys?.keys.find((k) => k.publicKey === sda.publicKey);
    add(
      'sender_key_full_access',
      key?.permission === 'FullAccess',
      key ? String(key.permission === 'FullAccess') : 'key not on chain',
    );
    add(
      'nonce_fresh',
      key !== undefined && sda.nonce > key.nonce,
      key ? `${sda.nonce} > ${key.nonce}` : 'n/a',
    );
    add(
      'not_expired',
      sda.maxBlockHeight > block.height,
      `${sda.maxBlockHeight} > ${block.height}`,
    );

    const cost = (innerGas + OUTER_GAS_OVERHEAD) * gasPrice + innerDeposit;
    const available = relayerAcct ? relayerAcct.amount : 0n;
    add('relayer_balance', available > cost, `${available} > ${cost}`);

    for (const a of sda.actions) {
      if (
        a.type !== 'FunctionCall' ||
        (a.methodName !== 'ft_transfer' && a.methodName !== 'ft_transfer_call')
      )
        continue;
      try {
        const args = JSON.parse(new TextDecoder().decode(a.args)) as {
          receiver_id?: unknown;
          amount?: unknown;
        };
        if (typeof args.amount !== 'string' || typeof args.receiver_id !== 'string')
          throw new Error('bad ft args');
        const [bal, reg] = await Promise.all([
          ftBalanceOf(this.o.rpc, sda.receiverId, sda.senderId),
          storageBalanceOf(this.o.rpc, sda.receiverId, args.receiver_id),
        ]);
        add('ft_balance', bal >= BigInt(args.amount), `${bal} >= ${args.amount}`);
        const registersInBatch = sda.actions.some(
          (x) => x.type === 'FunctionCall' && x.methodName === 'storage_deposit',
        );
        add(
          'ft_receiver_registered',
          reg !== null || registersInBatch,
          reg !== null
            ? 'registered'
            : registersInBatch
              ? 'registered in same batch'
              : 'not registered',
        );
      } catch (e) {
        add('ft_balance', false, (e as Error).message);
      }
    }
    return {
      wouldSucceed: checks.every((c) => c.ok),
      checks,
      estimatedRelayerCostYocto: cost.toString(),
    };
  }
}
