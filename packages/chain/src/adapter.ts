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
} from './near/ft.ts';
import { KeyPairSigner, normalizeEd25519PublicKey, type TxSigner } from './near/keys.ts';
import {
  type ChainMode,
  DEFAULT_MODE,
  isLive,
  type LiveRequest,
  modeFromEnv,
} from './near/mode.ts';
import { NearRelayer, RelayError } from './near/relayer.ts';
import { MAINNET_RPC_URL, NearRpc, RpcError } from './near/rpc.ts';
import { type ApprovalSigningFields, STORAGE_PRICE_PER_BYTE } from './near/types.ts';

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
  /** Destination-chain address (e.g. Glider smart account) */
  recipient: string;
  /** The user's NEAR account (refunds go back here, on NEAR). */
  userAccountId: string;
  slippageBps?: number;
  minReceived?: bigint;
  dry?: boolean;
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
  /** Blocks from head for a fresh signing window. Default 200 (~2-3 min). */
  signingWindowBlocks?: bigint;
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
  readonly oneClick: OneClickClient;
  readonly glider: GliderClient | undefined;
  private readonly accounts: AccountFactory;
  private readonly relayer: NearRelayer | null;
  private readonly dryHashes = new Set<string>();
  private readonly now: () => Date;

  constructor(private readonly o: ChainAdapterOptions) {
    this.rpc = o.rpc ?? new NearRpc({ url: MAINNET_RPC_URL });
    this.mode = o.mode ?? DEFAULT_MODE;
    this.oneClick = o.oneClick ?? new OneClickClient();
    this.glider = o.glider;
    this.now = o.now ?? (() => new Date());
    this.accounts = new AccountFactory({
      rpc: this.rpc,
      appAccountId: o.appAccountId,
      mode: this.mode,
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
          ...(o.relayerSigner ? { signer: o.relayerSigner } : {}),
        })
      : null;
  }

  private liveRequest(): LiveRequest {
    // The adapter asks for live only when its own config is live; NearRelayer re-checks.
    return this.mode.env === 'mainnet' && !this.mode.dryRun
      ? { dryRun: false, env: 'mainnet' }
      : { dryRun: true };
  }

  get isLive(): boolean {
    return isLive(this.mode, this.o.relayerSigner !== undefined, this.liveRequest());
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
      const r = await verifySignedDelegateAction(sdaB64, approval, this.rpc, {
        ...this.o.verifyPolicy,
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
    const v = await this.verifyDelegateAction(approval, sdaB64);
    if (!v.ok) return v;
    try {
      const r = await this.relayer.relay(sdaB64, this.liveRequest());
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
      maxBlockHeight: (block.height + (this.o.signingWindowBlocks ?? 200n)).toString(),
    };
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
        recipientType: 'DESTINATION_CHAIN',
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
      ftBalanceOf(this.rpc, USDC_CONTRACT, accountId),
      storageBalanceOf(this.rpc, USDC_CONTRACT, accountId),
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
  GLIDER_API_KEY: z.string().optional(),
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
    oneClick: new OneClickClient(e.ONECLICK_API_KEY ? { apiKey: e.ONECLICK_API_KEY } : {}),
    ...(e.GLIDER_API_KEY ? { glider: new GliderClient({ apiKey: e.GLIDER_API_KEY }) } : {}),
    ...extra,
  });
}
