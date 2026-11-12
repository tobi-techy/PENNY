import {
  type ChainView,
  normalizeEd25519PublicKey,
  verifySignedDelegateAction,
} from '@penny/chain';
import type { Approval, MoneyPlan, NearAction } from '@penny/shared';
import type {
  BuiltActions,
  ChainPort,
  GuardView,
  RelayResult,
  TxStatus,
  VerifyResult,
} from './chain.ts';

/**
 * ChainPort decorator for the public demo (/demo). Nothing here is a shortcut in
 * the approval flow: the Guard, the byte-for-byte check and the ed25519 signature
 * verification all still run. Only the two things a demo cannot own are replaced:
 *
 *  1. the device key is not on chain, so the "is this key really on this account"
 *     read is answered from the engine's own enrollment record instead of RPC;
 *  2. the relayer never broadcasts, so a demo approval ends at verified and is
 *     reported as a dry run.
 *
 * Every other account is passed straight through to the real adapter, so this
 * decorator is inert for production users.
 */
export type DemoChainDeps = {
  inner: ChainPort;
  /** True only for the throwaway accounts a demo session created. */
  isDemoAccount: (accountId: string) => Promise<boolean>;
  /** The enrolled device key for an account (same resolver the real adapter uses). */
  resolveDeviceKey: (accountId: string) => Promise<string | null>;
};

/** A block height the synthetic view reports. Any value works: nothing is broadcast. */
const DEMO_BLOCK_HEIGHT = 1n;

export class DemoChain implements ChainPort {
  constructor(private readonly d: DemoChainDeps) {}

  async verifyDelegateAction(approval: Approval, b64: string): Promise<VerifyResult> {
    if (!(await this.d.isDemoAccount(approval.signerId))) {
      return this.d.inner.verifyDelegateAction(approval, b64);
    }
    if (Date.parse(approval.expiresAt) <= Date.now())
      return { ok: false, reason: 'EXPIRED: approval expired' };
    const device = await this.d.resolveDeviceKey(approval.signerId);
    if (!device) return { ok: false, reason: 'KEY_NOT_EXPECTED: no enrolled device' };
    const expectedPublicKey = normalizeEd25519PublicKey(device);
    const approved = approvedDeposit(approval.actions);
    const r = await verifySignedDelegateAction(b64, approval, demoView(expectedPublicKey), {
      expectedPublicKey,
      ...(approved > 0n ? { maxTotalDeposit: approved } : {}),
    });
    return r.ok ? { ok: true } : { ok: false, reason: `${r.reason}: ${r.detail}` };
  }

  /** The device key is not on chain, so answer from the enrollment record. */
  async prepareSigning(
    signerId: string,
    publicKeyEd25519B64Url: string,
    windowSec?: number,
  ): Promise<{ nonce: string; maxBlockHeight: string }> {
    if (!(await this.d.isDemoAccount(signerId))) {
      return this.d.inner.prepareSigning(signerId, publicKeyEd25519B64Url, windowSec);
    }
    // 0.6 s blocks, the same window the real adapter reserves for the card's lifetime.
    const blocks = BigInt(Math.ceil((windowSec ?? 600) / 0.6));
    return { nonce: '1', maxBlockHeight: (DEMO_BLOCK_HEIGHT + blocks).toString() };
  }

  /** Never broadcasts. A demo approval stops here, reported as a dry run. */
  async relay(approval: Approval, _b64: string): Promise<RelayResult> {
    if (!(await this.d.isDemoAccount(approval.signerId))) {
      return this.d.inner.relay(approval, _b64);
    }
    return { ok: true, txHash: `demo-${approval.id}`, dryRun: true };
  }

  /** No transaction exists: stay pending so nothing claims an outcome it cannot see. */
  async txStatus(txHash: string): Promise<TxStatus> {
    if (txHash.startsWith('demo-')) return 'pending';
    return this.d.inner.txStatus(txHash);
  }

  createUserAccount(slug: string, publicKeyEd25519B64Url: string) {
    return this.d.inner.createUserAccount(slug, publicKeyEd25519B64Url);
  }

  buildActions(
    plan: MoneyPlan,
    signerId: string,
  ): Promise<Omit<BuiltActions, 'nonce' | 'maxBlockHeight'>> {
    return this.d.inner.buildActions(plan, signerId);
  }

  /**
   * Never the shared Guard contract. A throwaway owner can not hold an allowance in
   * it, so asking would block every demo send for a reason the page never shows and
   * the approval it exists to demonstrate would never appear. The policy numbers the
   * page prints are the whole gate here.
   */
  async guardFor(ownerAccountId: string): Promise<GuardView | undefined> {
    if (await this.d.isDemoAccount(ownerAccountId)) return undefined;
    return this.d.inner.guardFor?.(ownerAccountId);
  }
}

/** A ChainView that reports the enrolled device key as a full-access key of the account. */
function demoView(publicKey: string): ChainView {
  return {
    viewAccessKeyList: async () => ({
      keys: [{ publicKey, nonce: 0n, permission: 'FullAccess' as const }],
      blockHeight: DEMO_BLOCK_HEIGHT,
    }),
  };
}

function approvedDeposit(actions: NearAction[]): bigint {
  let sum = 0n;
  for (const a of actions) sum += BigInt(a.deposit);
  return sum;
}
