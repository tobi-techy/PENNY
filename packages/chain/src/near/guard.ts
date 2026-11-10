import { actionCreators } from '@near-js/transactions';
import { canonicalBytes } from '../util/canonical.ts';
import { USDC_STORAGE_DEPOSIT } from './ft.ts';
import { publicKeyFromString, type TxSigner } from './keys.ts';
import { type ChainMode, DEFAULT_MODE, isLive, type LiveRequest } from './mode.ts';
import type { NearRpc } from './rpc.ts';
import { buildTx, signTx } from './tx.ts';

const TGAS = 1_000_000_000_000n;
const GAS_CALL = 30n * TGAS;
const GAS_SPEND = 100n * TGAS;
const ONE_YOCTO = 1n;

/**
 * TypeScript client for the penny-guard contract (contracts/guard).
 *
 * The contract is deployed once as a shared, locked account (for example
 * `guard.penny.testnet`) and initialised with `new(tokens)`. Tokens are fixed for
 * life; there is no `add_token` and no per-user `guard.<user>` account. Every
 * owner's budgets and agent policies live under keys prefixed with that owner's
 * account id, so one deployment serves every user.
 *
 * Owner calls (`set_policy`/`pause_*`/`resume_*`/`revoke_*`/`withdraw`) are signed
 * by the owner account and carry 1 yocto. The owner is an explicit argument on
 * every owner-scoped call because one client instance serves every owner. Agent
 * `spend` is called by the agent account itself and names the owner.
 *
 * Everything is dry-run unless the mode gate (mode.ts) says live.
 */
export type GuardTokenLimit = { token: string; perTxCap: string; dailyCap: string };
export type GuardPolicyInput = {
  limits: GuardTokenLimit[];
  allowlist?: string[];
  /** Unix nanoseconds as a string. Omit for no expiry. */
  expiresAtNs?: string;
};
export type GuardPolicyView = {
  owner_id: string;
  agent_id: string;
  limits: { token: string; per_tx_cap: string; daily_cap: string }[];
  allowlist: string[];
  expires_at: string | null;
  paused: boolean;
  revoked: boolean;
  last_nonce: string;
};

export type GuardCallResult =
  | { mode: 'dry_run'; txHash: string; contractId: string; method: string }
  | { mode: 'broadcast'; txHash: string; contractId: string; method: string; outcome: unknown };

function policyArgs(policy: GuardPolicyInput) {
  return {
    limits: policy.limits.map((l) => ({
      token: l.token,
      per_tx_cap: l.perTxCap,
      daily_cap: l.dailyCap,
    })),
    allowlist: policy.allowlist ?? [],
    ...(policy.expiresAtNs ? { expires_at: policy.expiresAtNs } : {}),
  };
}

export class GuardContract {
  private readonly mode: ChainMode;

  constructor(
    private readonly o: {
      rpc: NearRpc;
      /** The shared contract id from config (PENNY_GUARD_CONTRACT), never per-user. */
      contractId: string;
      ownerSigner?: TxSigner;
      mode?: ChainMode;
    },
  ) {
    this.mode = o.mode ?? DEFAULT_MODE;
  }

  get contractId(): string {
    return this.o.contractId;
  }

  /**
   * Init plan for the shared contract: `new(tokens)` signed by the contract itself
   * or its parent. The account and wasm are deployed once by the operator
   * (`contracts/guard/build.sh`), not per user. Tokens are fixed for life.
   */
  deployActions(tokens: string[]) {
    if (!tokens.length) throw new Error('guard init needs at least one allowed token');
    return [actionCreators.functionCall('new', canonicalBytes({ tokens }), GAS_CALL, 0n)];
  }

  private async call(
    signer: TxSigner | undefined,
    signerId: string,
    method: string,
    args: Record<string, unknown>,
    opts: { gas?: bigint; deposit?: bigint; live?: LiveRequest } = {},
  ): Promise<GuardCallResult> {
    if (!signer) {
      // No key material: still build the tx hash a signer would produce is
      // impossible without a key, so report a plan-only dry run.
      return {
        mode: 'dry_run',
        txHash: `dry_${method}_${this.o.contractId}`,
        contractId: this.o.contractId,
        method,
      };
    }
    const key = await this.o.rpc.viewAccessKey(signerId, signer.publicKey.toString());
    if (!key) {
      // Dry-run planning must not need chain state; a live call fails closed.
      if (isLive(this.mode, true, opts.live ?? { dryRun: true })) {
        throw new Error(`signer key not found on ${signerId}`);
      }
      return {
        mode: 'dry_run',
        txHash: `dry_${method}_${this.o.contractId}`,
        contractId: this.o.contractId,
        method,
      };
    }
    const built = buildTx({
      signerId,
      signerPublicKey: publicKeyFromString(signer.publicKey.toString()),
      receiverId: this.o.contractId,
      nonce: key.nonce + 1n,
      actions: [
        actionCreators.functionCall(
          method,
          canonicalBytes(args),
          opts.gas ?? GAS_CALL,
          opts.deposit ?? 0n,
        ),
      ],
      blockHash: key.blockHash,
    });
    if (!isLive(this.mode, true, opts.live ?? { dryRun: true })) {
      return { mode: 'dry_run', txHash: built.hash, contractId: this.o.contractId, method };
    }
    const signed = await signTx(built, signer);
    const outcome = await this.o.rpc.sendTx(signed.signedBase64, 'EXECUTED_OPTIMISTIC');
    return { mode: 'broadcast', txHash: built.hash, contractId: this.o.contractId, method, outcome };
  }

  /**
   * Owner-signed call. The signer must be the owner named in the call, otherwise a
   * shared-contract client could mutate another owner's policy.
   */
  private ownerCall(
    ownerAccountId: string,
    method: string,
    args: Record<string, unknown>,
    live?: LiveRequest,
  ) {
    if (this.o.ownerSigner && this.o.ownerSigner.accountId !== ownerAccountId) {
      throw new Error(
        `guard owner signer is ${this.o.ownerSigner.accountId}, not ${ownerAccountId}`,
      );
    }
    return this.call(this.o.ownerSigner, ownerAccountId, method, args, {
      deposit: ONE_YOCTO,
      ...(live ? { live } : {}),
    });
  }

  setPolicy(
    ownerAccountId: string,
    agentId: string,
    policy: GuardPolicyInput,
    live?: LiveRequest,
  ) {
    return this.ownerCall(
      ownerAccountId,
      'set_policy',
      { agent_id: agentId, policy: policyArgs(policy) },
      live,
    );
  }
  pauseAgent(ownerAccountId: string, agentId: string, live?: LiveRequest) {
    return this.ownerCall(ownerAccountId, 'pause_agent', { agent_id: agentId }, live);
  }
  resumeAgent(ownerAccountId: string, agentId: string, live?: LiveRequest) {
    return this.ownerCall(ownerAccountId, 'resume_agent', { agent_id: agentId }, live);
  }
  revokeAgent(ownerAccountId: string, agentId: string, live?: LiveRequest) {
    return this.ownerCall(ownerAccountId, 'revoke_agent', { agent_id: agentId }, live);
  }
  pauseAll(ownerAccountId: string, live?: LiveRequest) {
    return this.ownerCall(ownerAccountId, 'pause_all', {}, live);
  }
  resumeAll(ownerAccountId: string, live?: LiveRequest) {
    return this.ownerCall(ownerAccountId, 'resume_all', {}, live);
  }
  withdraw(ownerAccountId: string, token: string, amountBaseUnits: string, live?: LiveRequest) {
    return this.ownerCall(ownerAccountId, 'withdraw', { token, amount: amountBaseUnits }, live);
  }

  /** Agent-initiated spend. The agent account signs; the contract enforces caps. */
  spend(
    agentSigner: TxSigner,
    input: {
      ownerAccountId: string;
      token: string;
      recipient: string;
      amountBaseUnits: string;
      nonce: string;
      memo?: string;
    },
    live?: LiveRequest,
  ) {
    return this.call(
      agentSigner,
      agentSigner.accountId,
      'spend',
      {
        owner_id: input.ownerAccountId,
        token: input.token,
        recipient: input.recipient,
        amount: input.amountBaseUnits,
        memo: input.memo ?? null,
        nonce: input.nonce,
      },
      { gas: GAS_SPEND, deposit: 0n, ...(live ? { live } : {}) },
    );
  }

  // ---- views (no signer, no gas) ----
  async getTokens(): Promise<string[]> {
    return ((await this.o.rpc.callView(this.o.contractId, 'get_tokens', {})) ?? []) as string[];
  }
  async getPolicy(ownerAccountId: string, agentId: string): Promise<GuardPolicyView | null> {
    return (await this.o.rpc.callView(this.o.contractId, 'get_policy', {
      owner_id: ownerAccountId,
      agent_id: agentId,
    })) as GuardPolicyView | null;
  }
  async getAgents(ownerAccountId: string): Promise<GuardPolicyView[]> {
    return ((await this.o.rpc.callView(this.o.contractId, 'get_agents', {
      owner_id: ownerAccountId,
    })) ?? []) as GuardPolicyView[];
  }
  async getSpentToday(ownerAccountId: string, agentId: string, token: string): Promise<string> {
    const r = await this.o.rpc.callView(this.o.contractId, 'get_spent_today', {
      owner_id: ownerAccountId,
      agent_id: agentId,
      token,
    });
    return String(r ?? '0');
  }
  async getBudget(ownerAccountId: string, token: string): Promise<string> {
    const r = await this.o.rpc.callView(this.o.contractId, 'get_budget', {
      owner_id: ownerAccountId,
      token,
    });
    return String(r ?? '0');
  }
  async isPausedAll(ownerAccountId: string): Promise<boolean> {
    return Boolean(
      await this.o.rpc.callView(this.o.contractId, 'is_paused_all', { owner_id: ownerAccountId }),
    );
  }
}

export { USDC_STORAGE_DEPOSIT };
