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
 * One guard contract per user: `guard.<userAccountId>`, owned by the user.
 * Owner calls (set_policy/pause/revoke/...) attach exactly 1 yocto as the
 * contract requires. Agent spend is called by the agent account itself.
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

export function guardContractId(userAccountId: string): string {
  return `guard.${userAccountId}`;
}

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
      contractId: string;
      ownerAccountId: string;
      ownerSigner?: TxSigner;
      mode?: ChainMode;
    },
  ) {
    this.mode = o.mode ?? DEFAULT_MODE;
  }

  static forUser(rpc: NearRpc, userAccountId: string, ownerSigner?: TxSigner, mode?: ChainMode) {
    return new GuardContract({
      rpc,
      contractId: guardContractId(userAccountId),
      ownerAccountId: userAccountId,
      ...(ownerSigner ? { ownerSigner } : {}),
      ...(mode ? { mode } : {}),
    });
  }

  get contractId(): string {
    return this.o.contractId;
  }

  /**
   * Deploy plan: create `guard.<user>` and deploy code in one tx from the
   * user account, then `new(owner, tokens)` must be called by the owner.
   * Returns the unsigned plan; live deploy needs the wasm bytes + signer.
   */
  deployActions(codeBytes: Uint8Array, tokens: string[]) {
    if (!tokens.length) throw new Error('guard deploy needs at least one allowed token');
    return [
      actionCreators.createAccount(),
      actionCreators.deployContract(codeBytes),
      actionCreators.functionCall(
        'new',
        canonicalBytes({ owner_id: this.o.ownerAccountId, tokens }),
        GAS_CALL,
        0n,
      ),
    ];
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
      return { mode: 'dry_run', txHash: `dry_${method}_${this.o.contractId}`, contractId: this.o.contractId, method };
    }
    const key = await this.o.rpc.viewAccessKey(signerId, signer.publicKey.toString());
    if (!key) {
      // Dry-run planning must not need chain state; a live call fails closed.
      if (isLive(this.mode, true, opts.live ?? { dryRun: true })) {
        throw new Error(`signer key not found on ${signerId}`);
      }
      return { mode: 'dry_run', txHash: `dry_${method}_${this.o.contractId}`, contractId: this.o.contractId, method };
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

  private ownerCall(method: string, args: Record<string, unknown>, live?: LiveRequest) {
    return this.call(this.o.ownerSigner, this.o.ownerAccountId, method, args, {
      deposit: ONE_YOCTO,
      ...(live ? { live } : {}),
    });
  }

  setPolicy(agentId: string, policy: GuardPolicyInput, live?: LiveRequest) {
    return this.ownerCall('set_policy', { agent_id: agentId, policy: policyArgs(policy) }, live);
  }
  pauseAgent(agentId: string, live?: LiveRequest) {
    return this.ownerCall('pause_agent', { agent_id: agentId }, live);
  }
  resumeAgent(agentId: string, live?: LiveRequest) {
    return this.ownerCall('resume_agent', { agent_id: agentId }, live);
  }
  revokeAgent(agentId: string, live?: LiveRequest) {
    return this.ownerCall('revoke_agent', { agent_id: agentId }, live);
  }
  pauseAll(live?: LiveRequest) {
    return this.ownerCall('pause_all', {}, live);
  }
  resumeAll(live?: LiveRequest) {
    return this.ownerCall('resume_all', {}, live);
  }
  addToken(token: string, live?: LiveRequest) {
    return this.ownerCall('add_token', { token }, live);
  }
  withdraw(token: string, amountBaseUnits: string, live?: LiveRequest) {
    return this.ownerCall('withdraw', { token, amount: amountBaseUnits }, live);
  }

  /** Agent-initiated spend. The agent account signs; the contract enforces caps. */
  spend(
    agentSigner: TxSigner,
    input: { token: string; recipient: string; amountBaseUnits: string; nonce: string; memo?: string },
    live?: LiveRequest,
  ) {
    return this.call(
      agentSigner,
      agentSigner.accountId,
      'spend',
      {
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
  async getPolicy(agentId: string): Promise<GuardPolicyView | null> {
    return (await this.o.rpc.callView(this.o.contractId, 'get_policy', {
      agent_id: agentId,
    })) as GuardPolicyView | null;
  }
  async getSpentToday(agentId: string, token: string): Promise<string> {
    const r = await this.o.rpc.callView(this.o.contractId, 'get_spent_today', {
      agent_id: agentId,
      token,
    });
    return String(r ?? '0');
  }
  async getBudget(token: string): Promise<string> {
    const r = await this.o.rpc.callView(this.o.contractId, 'get_budget', { token });
    return String(r ?? '0');
  }
  async isPausedAll(): Promise<boolean> {
    return Boolean(await this.o.rpc.callView(this.o.contractId, 'is_paused_all', {}));
  }
}

export { USDC_STORAGE_DEPOSIT };
