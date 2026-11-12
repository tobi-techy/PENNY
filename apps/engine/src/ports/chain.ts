import type { GuardContract, GuardPolicyView, TxSigner } from '@penny/chain';
import { type Approval, type MoneyPlan, type NearAction, toBaseUnits } from '@penny/shared';

/**
 * ChainPort: the only way the engine touches NEAR. Real adapter comes from
 * packages/chain. Engine code depends on this interface, never on near-js.
 */
export type VerifyResult = { ok: true } | { ok: false; reason: string };

/**
 * The read side of the shared Guard contract the engine needs to check a spend.
 * A real GuardContract satisfies it; tests use FakeGuard.
 */
export type GuardView = Pick<
  GuardContract,
  'contractId' | 'getTokens' | 'getPolicy' | 'getSpentToday' | 'isPausedAll'
>;

export type RelayResult =
  | { ok: true; txHash: string; dryRun: boolean }
  | { ok: false; reason: string };

export type TxStatus = 'pending' | 'settled' | 'failed';

export type BuiltActions = {
  receiverId: string;
  actions: NearAction[];
  nonce: string; // access key nonce + 1
  maxBlockHeight: string;
};

export interface ChainPort {
  /**
   * Decode the borsh SignedDelegateAction and check it matches the approval
   * byte-for-byte: sender_id == signerId, receiver_id, actions (method, args,
   * gas, deposit), nonce, max_block_height, signature by a full-access key of
   * signerId that equals the enrolled device key.
   */
  verifyDelegateAction(approval: Approval, signedDelegateActionB64: string): Promise<VerifyResult>;
  /** Relay a verified delegate action from the relayer account. Honors DRY_RUN. */
  relay(approval: Approval, signedDelegateActionB64: string): Promise<RelayResult>;
  txStatus(txHash: string): Promise<TxStatus>;
  /** Create <slug>.penny.near with the device key as the only full-access key. */
  createUserAccount(
    slug: string,
    publicKeyEd25519B64Url: string,
  ): Promise<{ ok: true; accountId: string; dryRun: boolean } | { ok: false; reason: string }>;
  /** Deterministically build the exact NEAR actions for a validated plan. */
  buildActions(
    plan: MoneyPlan,
    signerId: string,
  ): Promise<Omit<BuiltActions, 'nonce' | 'maxBlockHeight'>>;
  /**
   * Next nonce + max block height for the user's device key. The block window
   * covers `windowSec` (the approval's lifetime) so the deadline on chain is
   * never earlier than the card's countdown.
   */
  prepareSigning(
    signerId: string,
    publicKeyEd25519B64Url: string,
    windowSec?: number,
  ): Promise<{ nonce: string; maxBlockHeight: string }>;
  /**
   * Client for the configured shared Guard contract. Undefined when
   * PENNY_GUARD_CONTRACT is unset (the shared Guard check is off). The owner
   * account is passed to each owner-scoped call, not derived per user.
   * May be async: the demo decides by looking its throwaway accounts up.
   */
  guardFor?(
    ownerAccountId: string,
    ownerSigner?: TxSigner,
  ): GuardView | undefined | Promise<GuardView | undefined>;
}

/** In-memory shared Guard for tests and DRY_RUN dev. Never touches a network. */
export class FakeGuard implements GuardView {
  contractId = 'guard.penny.testnet';
  pausedAll = false;
  /** dollar token the fake shared Guard was initialised with */
  tokens: string[] = ['tusd.penny.testnet'];
  /** "owner|agent" -> policy, unset = no policy */
  policies = new Map<string, GuardPolicyView | null>();
  /** "owner|agent|token" -> base units spent today */
  spentToday = new Map<string, string>();
  /** Method name to make throw (a flaky or unavailable RPC), or null. */
  fail: string | null = null;

  private maybeFail(method: string) {
    if (this.fail === method) throw new Error(`${method} unavailable`);
  }

  setPolicy(owner: string, agent: string, policy: GuardPolicyView | null) {
    this.policies.set(`${owner}|${agent}`, policy);
    return this;
  }

  setSpentToday(owner: string, agent: string, token: string, amount: string) {
    this.spentToday.set(`${owner}|${agent}|${token}`, amount);
    return this;
  }

  async getTokens(): Promise<string[]> {
    this.maybeFail('getTokens');
    return this.tokens;
  }

  async getPolicy(ownerAccountId: string, agentId: string): Promise<GuardPolicyView | null> {
    this.maybeFail('getPolicy');
    return this.policies.get(`${ownerAccountId}|${agentId}`) ?? null;
  }

  async getSpentToday(ownerAccountId: string, agentId: string, token: string): Promise<string> {
    this.maybeFail('getSpentToday');
    return this.spentToday.get(`${ownerAccountId}|${agentId}|${token}`) ?? '0';
  }

  async isPausedAll(ownerAccountId: string): Promise<boolean> {
    this.maybeFail('isPausedAll');
    void ownerAccountId;
    return this.pausedAll;
  }
}

/** Deterministic fake for tests and DRY_RUN dev. Never touches a network. */
export class FakeChain implements ChainPort {
  verifyCalls: string[] = [];
  relayCalls: string[] = [];
  /** set to force verify failures in tests */
  nextVerify: VerifyResult = { ok: true };
  nextRelay: RelayResult | null = null;
  statuses = new Map<string, TxStatus>();
  accounts = new Map<string, string>();
  /** Set to exercise the shared Guard gate; unset keeps on-chain checks off. */
  guard: FakeGuard | null = null;

  guardFor(_ownerAccountId: string): GuardView | undefined {
    return this.guard ?? undefined;
  }

  async verifyDelegateAction(approval: Approval, b64: string): Promise<VerifyResult> {
    this.verifyCalls.push(approval.id);
    if (b64.length < 4) return { ok: false, reason: 'empty delegate action' };
    return this.nextVerify;
  }

  async relay(approval: Approval, _b64: string): Promise<RelayResult> {
    this.relayCalls.push(approval.id);
    if (this.nextRelay) return this.nextRelay;
    const txHash = `dry_${approval.id.slice(4, 16)}`;
    this.statuses.set(txHash, 'settled');
    return { ok: true, txHash, dryRun: true };
  }

  async txStatus(txHash: string): Promise<TxStatus> {
    return this.statuses.get(txHash) ?? 'pending';
  }

  async createUserAccount(slug: string, pk: string) {
    const accountId = `${slug}.penny.near`;
    if (this.accounts.has(accountId)) return { ok: false as const, reason: 'account exists' };
    this.accounts.set(accountId, pk);
    return { ok: true as const, accountId, dryRun: true };
  }

  usdcContract = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
  /** quoteId -> 1Click deposit address, filled by FakeInvest.firm (mirrors the adapter's quote cache) */
  investDeposits = new Map<string, string>();

  async buildActions(plan: MoneyPlan, _signerId: string) {
    if (plan.kind === 'invest') {
      const dep = this.investDeposits.get(plan.quoteId);
      if (!dep) throw new Error(`unknown quote ${plan.quoteId}`);
      return {
        receiverId: this.usdcContract,
        actions: [
          {
            type: 'FunctionCall' as const,
            methodName: 'storage_deposit',
            args: { account_id: dep, registration_only: true },
            gas: '10000000000000',
            deposit: '1250000000000000000000',
          },
          {
            type: 'FunctionCall' as const,
            methodName: 'ft_transfer',
            args: { receiver_id: dep, amount: toBaseUnits(plan.amountUsd, 6).toString() },
            gas: '30000000000000',
            deposit: '1',
          },
        ],
      };
    }
    if (plan.kind === 'pay_bill') {
      return {
        receiverId: this.usdcContract,
        actions: [
          {
            type: 'FunctionCall' as const,
            methodName: 'ft_transfer',
            args: { receiver_id: plan.payee, amount: toBaseUnits(plan.amount, 6).toString() },
            gas: '30000000000000',
            deposit: '1',
          },
        ],
      };
    }
    if (plan.kind === 'send' && plan.asset === 'NEAR') {
      return {
        receiverId: plan.to,
        actions: [{ type: 'Transfer' as const, deposit: toBaseUnits(plan.amount, 24).toString() }],
      };
    }
    const amount = plan.amount;
    const receiver = plan.kind === 'send' ? plan.to : 'intents.near';
    return {
      receiverId: this.usdcContract,
      actions: [
        {
          type: 'FunctionCall' as const,
          methodName: plan.kind === 'send' ? 'ft_transfer' : 'ft_transfer_call',
          args: { receiver_id: receiver, amount: toBaseUnits(amount, 6).toString() },
          gas: '30000000000000',
          deposit: '1',
        },
      ],
    };
  }

  async prepareSigning(_signerId: string, _pk: string, _windowSec?: number) {
    return { nonce: '1001', maxBlockHeight: '200000000' };
  }
}
