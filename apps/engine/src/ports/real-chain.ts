import { type ChainAdapter, GuardContract, type TxSigner } from '@penny/chain';
import type { Approval, MoneyPlan, NearAction } from '@penny/shared';
import type { BuiltActions, ChainPort, RelayResult, TxStatus, VerifyResult } from './chain.ts';

/**
 * Real ChainPort backed by packages/chain (ChainAdapter).
 * Dry-run unless the chain mode gate (PENNY_ENV=mainnet + DRY_RUN=0 + keys)
 * says live. Testnet RPC + dry mode is the default wiring when NEAR_RPC_URL
 * is set; FakeChain remains the offline dev fallback.
 */
export class RealChain implements ChainPort {
  constructor(readonly adapter: ChainAdapter) {}

  async verifyDelegateAction(
    approval: Approval,
    signedDelegateActionB64: string,
  ): Promise<VerifyResult> {
    const r = await this.adapter.verifyDelegateAction(
      approval as unknown as Parameters<ChainAdapter['verifyDelegateAction']>[0],
      signedDelegateActionB64,
    );
    return r.ok ? { ok: true } : { ok: false, reason: r.reason };
  }

  async relay(approval: Approval, signedDelegateActionB64: string): Promise<RelayResult> {
    const r = await this.adapter.relay(
      approval as unknown as Parameters<ChainAdapter['relay']>[0],
      signedDelegateActionB64,
    );
    return r.ok
      ? { ok: true, txHash: r.txHash, dryRun: r.dryRun }
      : { ok: false, reason: r.reason };
  }

  txStatus(txHash: string): Promise<TxStatus> {
    return this.adapter.txStatus(txHash);
  }

  createUserAccount(slug: string, publicKeyEd25519B64Url: string) {
    return this.adapter.createUserAccount(slug, publicKeyEd25519B64Url);
  }

  async buildActions(
    plan: MoneyPlan,
    signerId: string,
  ): Promise<Omit<BuiltActions, 'nonce' | 'maxBlockHeight'>> {
    const r = await this.adapter.buildActions(
      plan as unknown as Parameters<ChainAdapter['buildActions']>[0],
      signerId,
    );
    return { receiverId: r.receiverId, actions: r.actions as NearAction[] };
  }

  prepareSigning(signerId: string, publicKeyEd25519B64Url: string, windowSec?: number) {
    return this.adapter.prepareSigning(signerId, publicKeyEd25519B64Url, windowSec);
  }

  /**
   * Client for the configured shared Guard contract, owner-signed when a signer is
   * supplied. Returns undefined when PENNY_GUARD_CONTRACT is unset (the shared
   * Guard check is off). The owner account is passed to each owner-scoped call,
   * not derived per user.
   */
  guardFor(_userAccountId: string, ownerSigner?: TxSigner): GuardContract | undefined {
    const contractId = this.adapter.guardContract;
    if (!contractId) return undefined;
    return new GuardContract({
      rpc: this.adapter.rpc,
      contractId,
      mode: this.adapter.mode,
      ...(ownerSigner ? { ownerSigner } : {}),
    });
  }
}
