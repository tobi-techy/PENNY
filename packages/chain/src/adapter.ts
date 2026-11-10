import { z } from 'zod';
import { GliderClient } from './glider/client.ts';
import {
  buildDepositActions,
  type DepositPlan,
  OneClickClient,
  type ValidatedQuote,
} from './intents/oneclick.ts';
import { AccountError, AccountFactory } from './near/accounts.ts';
import { type VerifyPolicy, verifySignedDelegateAction } from './near/delegate.ts';
import {
  fromBaseUnits,
  ftBalanceOf,
  storageBalanceOf,
  toBaseUnits,
  USDC_ASSET_ID,
  USDC_CONTRACT,
  USDC_DECIMALS,
  USDC_STORAGE_DEPOSIT,
} from './near/ft.ts';
import { KeyPairSigner, normalizeEd25519PublicKey, type TxSigner } from './near/keys.ts';
import {
  type ChainMode,
  DEFAULT_MODE,
  isLive,
  isTestnetRpcUrl,
  type LiveRequest,
  modeFromEnv,
} from './near/mode.ts';
import { DEFAULT_RELAYER_HARD_CEILING, NearRelayer, RelayError } from './near/relayer.ts';
import { MAINNET_RPC_URL, NearRpc, RpcError } from './near/rpc.ts';
import {
  type ApprovalSigningFields,
  type NearActionSpec,
  STORAGE_PRICE_PER_BYTE,
} from './near/types.ts';

/** Structural subset of @penny/shared Approval the adapter needs (engine passes the full Approval). */
export type ApprovalLike = ApprovalSigningFields & { id: string; expiresAt: string };

export type AdapterVerifyResult = { ok: true } | { ok: false; reason: string };
export type AdapterRelayResult =
  | { ok: true; txHash: string; dryRun: boolean; simulated?: unknown }
  | { ok: false; reason: string };
export type TxStatus = 'pending' | 'settled' | 'failed';

export interface Balances {
  accountId: string;
  exists: boolean;
  near: { totalYocto: string; availableYocto: string; display: string };
  usdc: { raw: string; display: string; registered: boolean };
}

export interface QuoteInvestParams {
  /** Decimal USD string, e.g. "50" or "12.5" (ARCHITECTURE Decimal). Converted to USDC base units with bigint. */
  amountUsd: string;
  /** 1Click asset id of what to buy, e.g. nep141:base-0x8335...omft.near (USDC on Base for a Glider portfolio). */
  destinationAsset: string;
  /** Destination-chain address, or a NEAR account when recipientType is INTENTS. */
  recipient: string;
  /** Default DESTINATION_CHAIN. Invest uses INTENTS (asset lands in the user's own intents.near balance). */
  recipientType?: 'DESTINATION_CHAIN' | 'INTENTS';
  /** The user's NEAR account (refunds go back here, on NEAR). */
  userAccountId: string;
  slippageBps?: number;
  minReceived?: bigint;
  dry?: boolean;
}

/**
 * Blocks to allow for an approval that lives `windowSec`. NEAR makes a block about
 * every 0.6-1.2 s, so 2 blocks a second plus a minute of slack never ends early;
 * capped under the verifier's max-blocks-ahead bound (1500).
 */
export function signingWindowBlocks(windowSec: number | undefined, fallback?: bigint): bigint {
  if (!windowSec || windowSec <= 0) return fallback ?? 200n;
  const blocks = BigInt(Math.ceil(windowSec * 2) + 60);
  return blocks > 1400n ? 1400n : blocks;
}

export interface ChainAdapterOptions {
  rpc?: NearRpc;
  mode?: ChainMode;
  appAccountId: string;
  appSigner?: TxSigner;
  appPublicKey?: string;
  relayerAccountId: string;
  relayerSigner?: TxSigner;
  relayerPublicKey?: string;
  oneClick?: OneClickClient;
  glider?: GliderClient;
  /** Enrolled device key for a NEAR account (from the devices table). When set, verify requires an exact match. */
  resolveDeviceKey?: (signerId: string) => Promise<string | null>;
  verifyPolicy?: VerifyPolicy;
  /** Relayer inner-deposit cap for calls with no approval-derived limit (yocto). */
  relayerMaxInnerDepositYocto?: bigint;
  /** Env hard ceiling on any one approval's inner deposits (yocto). Default 1 NEAR. */
  relayerHardCeilingYocto?: bigint;
  /** Blocks from head for a fresh signing window. Default 200 (~2-3 min). */
  signingWindowBlocks?: bigint;
  /**
   * USDC token contract. Default: mainnet native USDC. On testnet, the Penny test
   * dollar (tUSD) so the same ft_transfer path runs with a token the user owns.
   */
  usdcContract?: string;
  /** Shared Guard contract (contracts/guard), e.g. guard.penny.testnet. Unset = autopilot off. */
  guardContract?: string;
  now?: () => Date;
}

/**
 * ChainAdapter: implements the engine's ChainPort (apps/engine/src/ports/chain.ts) plus
 * quoteInvest / getBalances / buildInvestDeposit. Dry-run by default; broadcasting
 * requires PENNY_ENV=mainnet AND DRY_RUN=0 AND keys present.
 */
export class ChainAdapter {
  readonly rpc: NearRpc;
  readonly mode: ChainMode;
  /** The USDC (or tUSD on testnet) token contract every dollar action uses. */
  readonly usdc: string;
  readonly guardContract: string | undefined;
  readonly oneClick: OneClickClient;
  readonly glider: GliderClient | undefined;
  private readonly accounts: AccountFactory;
  private readonly relayer: NearRelayer | null;
  private readonly dryHashes = new Set<string>();
  private readonly now: () => Date;

  constructor(private readonly o: ChainAdapterOptions) {
    this.rpc = o.rpc ?? new NearRpc({ url: MAINNET_RPC_URL });
    const mode = o.mode ?? DEFAULT_MODE;
    // Fail closed: a mode labelled testnet only keeps the testnet allowance when
    // the RPC this adapter actually talks to is a testnet host.
    this.mode =
      mode.network === 'testnet' && !isTestnetRpcUrl(this.rpc.url)
        ? { ...mode, network: 'mainnet' }
        : mode;
    // Mainnet only ever moves real USDC: an override there is a misconfiguration.
    if (this.mode.network !== 'testnet' && o.usdcContract && o.usdcContract !== USDC_CONTRACT) {
      throw new Error('NEAR_USDC_CONTRACT may only be overridden on testnet');
    }
    this.usdc = o.usdcContract ?? USDC_CONTRACT;
    this.guardContract = o.guardContract;
    this.oneClick = o.oneClick ?? new OneClickClient();
    this.glider = o.glider;
    this.now = o.now ?? (() => new Date());
    this.accounts = new AccountFactory({
      rpc: this.rpc,
      appAccountId: o.appAccountId,
      mode: this.mode,
      usdcContract: this.usdc,
      ...(o.appSigner ? { signer: o.appSigner } : {}),
      ...(o.appPublicKey ? { appPublicKey: o.appPublicKey } : {}),
    });
    const relayerPk = o.relayerPublicKey ?? o.relayerSigner?.publicKey.toString();
    this.relayer = relayerPk
      ? new NearRelayer({
          rpc: this.rpc,
          relayerAccountId: o.relayerAccountId,
          relayerPublicKey: relayerPk,
          mode: this.mode,
          ...(o.relayerMaxInnerDepositYocto !== undefined
            ? { maxInnerDepositYocto: o.relayerMaxInnerDepositYocto }
            : {}),
          ...(o.relayerHardCeilingYocto !== undefined
            ? { hardCeilingYocto: o.relayerHardCeilingYocto }
            : {}),
          ...(o.relayerSigner ? { signer: o.relayerSigner } : {}),
        })
      : null;
  }

  private liveRequest(): LiveRequest {
    // The adapter asks for live only when its own config is live; NearRelayer re-checks.
    if (this.mode.dryRun) return { dryRun: true };
    if (this.mode.network === 'testnet') return { dryRun: false, env: this.mode.env };
    return this.mode.env === 'mainnet' ? { dryRun: false, env: 'mainnet' } : { dryRun: true };
  }

  get isLive(): boolean {
    return isLive(this.mode, this.o.relayerSigner !== undefined, this.liveRequest());
  }

  /** Env hard ceiling on the NEAR the relayer fronts for one approval (yocto). */
  get relayerDepositCeilingYocto(): bigint {
    return this.o.relayerHardCeilingYocto ?? DEFAULT_RELAYER_HARD_CEILING;
  }

  async verifyDelegateAction(approval: ApprovalLike, sdaB64: string): Promise<AdapterVerifyResult> {
    if (Date.parse(approval.expiresAt) <= this.now().getTime())
      return { ok: false, reason: 'EXPIRED: approval expired' };
    let expectedPublicKey: string | undefined;
    if (this.o.resolveDeviceKey) {
      const k = await this.o.resolveDeviceKey(approval.signerId);
      if (!k) return { ok: false, reason: 'KEY_NOT_EXPECTED: no enrolled device' };
      expectedPublicKey = normalizeEd25519PublicKey(k);
    }
    try {
      const approved = approvedDepositYocto(approval);
      const r = await verifySignedDelegateAction(sdaB64, approval, this.rpc, {
        ...this.o.verifyPolicy,
        // The cap is the approved amount itself (bounded by the env ceiling in relay()).
        ...(approved > (this.o.verifyPolicy?.maxTotalDeposit ?? 0n)
          ? { maxTotalDeposit: approved }
          : {}),
        ...(expectedPublicKey ? { expectedPublicKey } : {}),
      });
      return r.ok ? { ok: true } : { ok: false, reason: `${r.reason}: ${r.detail}` };
    } catch (e) {
      return { ok: false, reason: `RPC: ${(e as Error).message}` };
    }
  }

  /** Re-verifies against the approval, then relays (dry by default). */
  async relay(approval: ApprovalLike, sdaB64: string): Promise<AdapterRelayResult> {
    if (!this.relayer) return { ok: false, reason: 'relayer not configured' };
    // Per-approval relayer limit = what the user approved, never above the env hard ceiling.
    const approved = approvedDepositYocto(approval);
    if (approved > this.relayerDepositCeilingYocto)
      return {
        ok: false,
        reason: `DEPOSIT_CAP: approved deposit ${approved} over relayer ceiling ${this.relayerDepositCeilingYocto}`,
      };
    const v = await this.verifyDelegateAction(approval, sdaB64);
    if (!v.ok) return v;
    try {
      const r = await this.relayer.relay(sdaB64, this.liveRequest(), {
        maxInnerDepositYocto: approved,
      });
      if (r.mode === 'dry_run') this.dryHashes.add(r.txHash);
      return { ok: true, txHash: r.txHash, dryRun: r.mode === 'dry_run', simulated: r.simulated };
    } catch (e) {
      const reason =
        e instanceof RelayError ? `RELAY: ${e.message}` : `RPC: ${(e as Error).message}`;
      return { ok: false, reason };
    }
  }

  /** Dry-run hashes report 'settled' (mirrors FakeChain) so the card flow completes in demos; they never hit chain. */
  async txStatus(txHash: string): Promise<TxStatus> {
    if (this.dryHashes.has(txHash)) return 'settled';
    try {
      const r = (await this.rpc.raw('tx', {
        tx_hash: txHash,
        sender_account_id: this.o.relayerAccountId,
        wait_until: 'NONE',
      })) as {
        status?: unknown;
        final_execution_status?: string;
      };
      const s = r.status as Record<string, unknown> | undefined;
      if (s && 'Failure' in s) return 'failed';
      if (s && 'SuccessValue' in s && r.final_execution_status !== 'NONE') return 'settled';
      return 'pending';
    } catch (e) {
      if (
        e instanceof RpcError &&
        (e.cause_name === 'UNKNOWN_TRANSACTION' || e.cause_name === 'TIMEOUT_ERROR')
      )
        return 'pending';
      throw e;
    }
  }

  async createUserAccount(
    slug: string,
    publicKey: string,
  ): Promise<{ ok: true; accountId: string; dryRun: boolean } | { ok: false; reason: string }> {
    try {
      const r = await this.accounts.createUserAccount(slug, publicKey, this.liveRequest());
      return { ok: true, accountId: r.accountId, dryRun: r.mode === 'dry_run' };
    } catch (e) {
      if (e instanceof AccountError) return { ok: false, reason: `${e.code}: ${e.message}` };
      return { ok: false, reason: `RPC: ${(e as Error).message}` };
    }
  }

  /** Next nonce + maxBlockHeight for the user's device key (fills Approval.nonce / maxBlockHeight). */
  async prepareSigning(
    signerId: string,
    publicKey: string,
    windowSec?: number,
  ): Promise<{ nonce: string; maxBlockHeight: string }> {
    const pk = normalizeEd25519PublicKey(publicKey);
    const [key, block] = await Promise.all([
      this.rpc.viewAccessKey(signerId, pk),
      this.rpc.finalBlock(),
    ]);
    if (!key) throw new Error(`device key not on ${signerId}`);
    if (key.permission !== 'FullAccess') throw new Error('device key is not full access');
    return {
      nonce: (key.nonce + 1n).toString(),
      maxBlockHeight: (block.height + signingWindowBlocks(windowSec, this.o.signingWindowBlocks)).toString(),
    };
  }

  private readonly investQuotes = new Map<string, ValidatedQuote>();

  /**
   * Deterministic NEAR actions for a validated plan. This is the ONLY place
   * plan -> actions happens for the real chain; the model never builds these.
   * Invest resolves its 1Click quote from the cache filled by quoteInvestForPlan.
   */
  async buildActions(
    plan:
      | { kind: 'send'; asset: 'USDC' | 'NEAR'; amount: string; to: string }
      | { kind: 'pay_bill'; payee: string; amount: string; asset: 'USDC' }
      | { kind: 'errand'; taskId: string; bidId: string; amount: string }
      | { kind: 'invest'; amountUsd: string; portfolioId: string; quoteId: string },
    signerId: string,
  ): Promise<{ receiverId: string; actions: NearActionSpec[] }> {
    void signerId;
    switch (plan.kind) {
      case 'send': {
        if (plan.asset === 'NEAR') {
          return {
            receiverId: plan.to,
            actions: [{ type: 'Transfer', deposit: toBaseUnits(plan.amount, 24).toString() }],
          };
        }
        return this.usdcTransfer(plan.to, toBaseUnits(plan.amount, USDC_DECIMALS).toString());
      }
      case 'pay_bill':
        return this.usdcTransfer(plan.payee, toBaseUnits(plan.amount, USDC_DECIMALS).toString());
      case 'errand':
        return {
          receiverId: this.usdc,
          actions: [
            {
              type: 'FunctionCall',
              methodName: 'ft_transfer_call',
              args: {
                receiver_id: 'intents.near',
                amount: toBaseUnits(plan.amount, USDC_DECIMALS).toString(),
                msg: `${plan.taskId}:${plan.bidId}`,
              },
              gas: '30000000000000',
              deposit: '1',
            },
          ],
        };
      case 'invest': {
        const q = this.investQuotes.get(plan.quoteId);
        if (!q) throw new Error(`unknown quote ${plan.quoteId}; call quoteInvestForPlan first`);
        const dep = await this.buildInvestDeposit(q);
        return { receiverId: dep.receiverId, actions: dep.actions };
      }
    }
  }

  /** ft_transfer with a storage_deposit first when the receiver is unregistered. */
  private async usdcTransfer(
    to: string,
    amountBaseUnits: string,
  ): Promise<{ receiverId: string; actions: NearActionSpec[] }> {
    const registered = (await storageBalanceOf(this.rpc, this.usdc, to)) !== null;
    const actions: NearActionSpec[] = [];
    if (!registered) {
      actions.push({
        type: 'FunctionCall',
        methodName: 'storage_deposit',
        args: { account_id: to, registration_only: true },
        gas: '10000000000000',
        deposit: USDC_STORAGE_DEPOSIT.toString(),
      });
    }
    actions.push({
      type: 'FunctionCall',
      methodName: 'ft_transfer',
      args: { receiver_id: to, amount: amountBaseUnits },
      gas: '30000000000000',
      deposit: '1',
    });
    return { receiverId: this.usdc, actions };
  }

  /** Quote an invest plan and cache it under its quoteId for buildActions. */
  async quoteInvestForPlan(input: QuoteInvestParams & { quoteId: string }): Promise<ValidatedQuote> {
    const q = await this.quoteInvest(input);
    // drop stale entries; quotes live <= 120 s
    const t = this.now().getTime();
    for (const [k, v] of this.investQuotes)
      if (v.expiresAt.getTime() + 10 * 60_000 < t) this.investQuotes.delete(k);
    this.investQuotes.set(input.quoteId, q);
    return q;
  }

  getInvestQuote(quoteId: string): ValidatedQuote | undefined {
    return this.investQuotes.get(quoteId);
  }

  async quoteInvest(p: QuoteInvestParams): Promise<ValidatedQuote> {
    return this.oneClick.quote(
      {
        dry: p.dry ?? true,
        originAsset: USDC_ASSET_ID,
        destinationAsset: p.destinationAsset,
        amount: toBaseUnits(p.amountUsd, USDC_DECIMALS),
        slippageBps: p.slippageBps ?? 100,
        recipient: p.recipient,
        recipientType: p.recipientType ?? 'DESTINATION_CHAIN',
        refundTo: p.userAccountId,
        refundType: 'ORIGIN_CHAIN',
        depositType: 'ORIGIN_CHAIN',
      },
      p.minReceived !== undefined ? { minReceived: p.minReceived } : {},
    );
  }

  /** Actions for the approval card: storage_deposit (if needed) + ft_transfer to the 1Click deposit address. */
  async buildInvestDeposit(q: ValidatedQuote): Promise<DepositPlan> {
    if (!q.depositAddress) throw new Error('quote has no deposit address (dry quote?)');
    const token = q.response.quoteRequest.originAsset.slice('nep141:'.length);
    const reg = await storageBalanceOf(this.rpc, token, q.depositAddress);
    return buildDepositActions(q, { depositAddressRegistered: reg !== null });
  }

  async getBalances(accountId: string): Promise<Balances> {
    const acct = await this.rpc.viewAccount(accountId);
    if (!acct) {
      return {
        accountId,
        exists: false,
        near: { totalYocto: '0', availableYocto: '0', display: '0' },
        usdc: { raw: '0', display: '0', registered: false },
      };
    }
    const storageCost = BigInt(acct.storageUsage) * STORAGE_PRICE_PER_BYTE;
    const available = acct.amount > storageCost ? acct.amount - storageCost : 0n;
    const [usdc, reg] = await Promise.all([
      ftBalanceOf(this.rpc, this.usdc, accountId),
      storageBalanceOf(this.rpc, this.usdc, accountId),
    ]);
    return {
      accountId,
      exists: true,
      near: {
        totalYocto: acct.amount.toString(),
        availableYocto: available.toString(),
        display: fromBaseUnits(acct.amount, 24),
      },
      usdc: {
        raw: usdc.toString(),
        display: fromBaseUnits(usdc, USDC_DECIMALS),
        registered: reg !== null,
      },
    };
  }
}

/** Sum of attached deposits in an approval's actions (yocto): what the relayer fronts. */
export function approvedDepositYocto(approval: Pick<ApprovalSigningFields, 'actions'>): bigint {
  let sum = 0n;
  for (const a of approval.actions) sum += BigInt(a.deposit);
  return sum;
}

const Env = z.object({
  PENNY_ENV: z.enum(['dev', 'mainnet']).default('dev'),
  DRY_RUN: z.string().optional(),
  NEAR_RPC_URL: z.string().url().optional(),
  NEAR_APP_ACCOUNT_ID: z.string().default('penny.near'),
  NEAR_APP_PRIVATE_KEY: z.string().optional(),
  NEAR_APP_PUBLIC_KEY: z.string().optional(),
  NEAR_RELAYER_ACCOUNT_ID: z.string().optional(),
  NEAR_RELAYER_PRIVATE_KEY: z.string().optional(),
  NEAR_RELAYER_PUBLIC_KEY: z.string().optional(),
  ONECLICK_API_KEY: z.string().optional(),
  ONECLICK_JWT: z.string().optional(),
  PENNY_RELAYER_MAX_DEPOSIT_NEAR: z
    .string()
    .regex(/^\d+(\.\d{1,24})?$/)
    .optional(),
  GLIDER_API_KEY: z.string().optional(),
  NEAR_USDC_CONTRACT: z.string().optional(),
  PENNY_GUARD_CONTRACT: z.string().optional(),
});

/**
 * Build from env. Secrets are read here only and handed to constructors; never logged.
 * If the relayer IS the app account and no app key is given, the relayer key signs account creation.
 */
export function chainAdapterFromEnv(
  raw: Record<string, string | undefined> = process.env,
  extra: Partial<ChainAdapterOptions> = {},
): ChainAdapter {
  const e = Env.parse(raw);
  const mode = modeFromEnv(raw);
  const relayerId = e.NEAR_RELAYER_ACCOUNT_ID ?? e.NEAR_APP_ACCOUNT_ID;
  const relayerSigner = e.NEAR_RELAYER_PRIVATE_KEY
    ? new KeyPairSigner(relayerId, e.NEAR_RELAYER_PRIVATE_KEY)
    : undefined;
  const appSigner = e.NEAR_APP_PRIVATE_KEY
    ? new KeyPairSigner(e.NEAR_APP_ACCOUNT_ID, e.NEAR_APP_PRIVATE_KEY)
    : relayerId === e.NEAR_APP_ACCOUNT_ID
      ? relayerSigner
      : undefined;
  return new ChainAdapter({
    rpc: new NearRpc({ url: e.NEAR_RPC_URL ?? MAINNET_RPC_URL }),
    mode,
    appAccountId: e.NEAR_APP_ACCOUNT_ID,
    relayerAccountId: relayerId,
    ...(appSigner ? { appSigner } : {}),
    ...(e.NEAR_APP_PUBLIC_KEY ? { appPublicKey: e.NEAR_APP_PUBLIC_KEY } : {}),
    ...(relayerSigner ? { relayerSigner } : {}),
    ...(e.NEAR_RELAYER_PUBLIC_KEY ? { relayerPublicKey: e.NEAR_RELAYER_PUBLIC_KEY } : {}),
    oneClick: new OneClickClient({
      ...(e.ONECLICK_API_KEY ? { apiKey: e.ONECLICK_API_KEY } : {}),
      ...(e.ONECLICK_JWT ? { jwt: e.ONECLICK_JWT } : {}),
    }),
    ...(e.PENNY_RELAYER_MAX_DEPOSIT_NEAR
      ? { relayerHardCeilingYocto: toBaseUnits(e.PENNY_RELAYER_MAX_DEPOSIT_NEAR, 24) }
      : {}),
    ...(e.GLIDER_API_KEY ? { glider: new GliderClient({ apiKey: e.GLIDER_API_KEY }) } : {}),
    ...(e.NEAR_USDC_CONTRACT ? { usdcContract: e.NEAR_USDC_CONTRACT } : {}),
    ...(e.PENNY_GUARD_CONTRACT ? { guardContract: e.PENNY_GUARD_CONTRACT } : {}),
    ...extra,
  });
}
