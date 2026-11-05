import { type Action, actionCreators } from '@near-js/transactions';
import { canonicalBytes } from '../util/canonical.ts';
import { fromBaseUnits, USDC_CONTRACT, USDC_STORAGE_DEPOSIT } from './ft.ts';
import { normalizeEd25519PublicKey, publicKeyFromString, type TxSigner } from './keys.ts';
import { type ChainMode, DEFAULT_MODE, isLive, type LiveRequest } from './mode.ts';
import type { NearRpc } from './rpc.ts';
import { buildTx, signTx } from './tx.ts';
import { NEAR_ACCOUNT_RE, STORAGE_PRICE_PER_BYTE, TGAS } from './types.ts';

export const AGENT_NAMES = ['invest', 'guard', 'mail', 'finance', 'errand'] as const;
export type AgentName = (typeof AGENT_NAMES)[number];

/** Slugs that must never be handed to a user (agents, infra, impersonation risk). */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  ...AGENT_NAMES,
  'penny',
  'app',
  'relayer',
  'relay',
  'admin',
  'root',
  'treasury',
  'vault',
  'system',
  'support',
  'help',
  'security',
  'ops',
  'api',
  'www',
  'mail',
  'team',
  'official',
  'staff',
  'bot',
  'test',
  'dev',
]);

/**
 * An account with one full-access key uses ~182 bytes (observed on mainnet: penny.near,
 * storage_usage 182). 182 * 1e19 = 0.00182 NEAR. We fund 0.002 NEAR so the account
 * exists with headroom; the user never needs NEAR for gas (relayer pays).
 */
export const DEFAULT_INITIAL_BALANCE = 200n * STORAGE_PRICE_PER_BYTE; // 2e21 yocto = 0.002 NEAR

export class AccountError extends Error {
  override name = 'AccountError';
  constructor(
    message: string,
    readonly code:
      | 'INVALID_SLUG'
      | 'RESERVED_SLUG'
      | 'ACCOUNT_EXISTS'
      | 'APP_KEY_MISSING'
      | 'INVALID_KEY',
  ) {
    super(message);
  }
}

/** Slug rules: lowercase a-z0-9 with single inner '-' or '_', 2..32 chars, no dots (one level under the app account). */
export function validateSlug(slug: string): string {
  if (!/^[a-z0-9]+([-_][a-z0-9]+)*$/.test(slug) || slug.length < 2 || slug.length > 32) {
    throw new AccountError(`invalid slug "${slug}"`, 'INVALID_SLUG');
  }
  if (RESERVED_SLUGS.has(slug))
    throw new AccountError(`slug "${slug}" is reserved`, 'RESERVED_SLUG');
  return slug;
}

export function userAccountId(slug: string, appAccountId: string): string {
  const id = `${validateSlug(slug)}.${appAccountId}`;
  if (!NEAR_ACCOUNT_RE.test(id))
    throw new AccountError(`resulting account id invalid: ${id}`, 'INVALID_SLUG');
  return id;
}

/** CreateAccount + Transfer(initial) + AddKey(device key, FullAccess). The device key is the ONLY key added. */
export function buildCreateAccountActions(
  devicePubKey: string,
  initialBalanceYocto: bigint = DEFAULT_INITIAL_BALANCE,
): Action[] {
  let pk: string;
  try {
    pk = normalizeEd25519PublicKey(devicePubKey);
  } catch (e) {
    throw new AccountError((e as Error).message, 'INVALID_KEY');
  }
  return [
    actionCreators.createAccount(),
    actionCreators.transfer(initialBalanceYocto),
    actionCreators.addKey(publicKeyFromString(pk), actionCreators.fullAccessKey()),
  ];
}

/** App pays USDC storage for the new user so they can receive USDC (separate tx: different receiver). */
export function buildUsdcStorageActions(accountId: string): Action[] {
  return [
    actionCreators.functionCall(
      'storage_deposit',
      canonicalBytes({ account_id: accountId, registration_only: true }),
      10n * TGAS,
      USDC_STORAGE_DEPOSIT,
    ),
  ];
}

export interface PlannedTx {
  label: string;
  signerId: string;
  receiverId: string;
  actions: string[];
  txHash?: string;
}

export interface CreateUserAccountResult {
  mode: 'dry_run' | 'broadcast';
  accountId: string;
  devicePublicKey: string;
  txs: PlannedTx[];
  outcomes?: unknown[];
}

export interface AccountFactoryOptions {
  rpc: NearRpc;
  /** e.g. "penny.near". Only the parent can create `<slug>.<parent>`. */
  appAccountId: string;
  /** Needed to build the tx even in dry run. Defaults to signer.publicKey. */
  appPublicKey?: string;
  signer?: TxSigner;
  mode?: ChainMode;
  initialBalanceYocto?: bigint;
}

function describe(actions: Action[]): string[] {
  return actions.map((a) => {
    const kind =
      Object.keys(a).find(
        (k) => (a as unknown as Record<string, unknown>)[k] !== undefined && k !== 'enum',
      ) ?? 'unknown';
    return kind;
  });
}

export class AccountFactory {
  private readonly mode: ChainMode;
  private readonly appPublicKey: string | undefined;

  constructor(private readonly o: AccountFactoryOptions) {
    this.mode = o.mode ?? DEFAULT_MODE;
    this.appPublicKey = o.appPublicKey ?? o.signer?.publicKey.toString();
    if (o.signer && o.signer.accountId !== o.appAccountId)
      throw new AccountError('signer is not the app account', 'APP_KEY_MISSING');
  }

  /**
   * Create `<slug>.<app>` whose only full-access key is the device key.
   * Dry run (default) returns the planned txs and hashes without signing.
   */
  async createUserAccount(
    slug: string,
    devicePubKey: string,
    opts?: LiveRequest,
  ): Promise<CreateUserAccountResult> {
    const accountId = userAccountId(slug, this.o.appAccountId);
    const pk = (() => {
      try {
        return normalizeEd25519PublicKey(devicePubKey);
      } catch (e) {
        throw new AccountError((e as Error).message, 'INVALID_KEY');
      }
    })();
    if ((await this.o.rpc.viewAccount(accountId)) !== null)
      throw new AccountError(`${accountId} already exists`, 'ACCOUNT_EXISTS');

    const createActions = buildCreateAccountActions(
      pk,
      this.o.initialBalanceYocto ?? DEFAULT_INITIAL_BALANCE,
    );
    const storageActions = buildUsdcStorageActions(accountId);
    const txs: PlannedTx[] = [
      {
        label: 'create_account',
        signerId: this.o.appAccountId,
        receiverId: accountId,
        actions: describe(createActions),
      },
      {
        label: 'usdc_storage',
        signerId: this.o.appAccountId,
        receiverId: USDC_CONTRACT,
        actions: ['functionCall:storage_deposit'],
      },
    ];

    if (!this.appPublicKey) return { mode: 'dry_run', accountId, devicePublicKey: pk, txs };
    const key = await this.o.rpc.viewAccessKey(this.o.appAccountId, this.appPublicKey);
    if (!key)
      throw new AccountError(`app key not found on ${this.o.appAccountId}`, 'APP_KEY_MISSING');

    const pub = publicKeyFromString(this.appPublicKey);
    const tx1 = buildTx({
      signerId: this.o.appAccountId,
      signerPublicKey: pub,
      receiverId: accountId,
      nonce: key.nonce + 1n,
      actions: createActions,
      blockHash: key.blockHash,
    });
    const tx2 = buildTx({
      signerId: this.o.appAccountId,
      signerPublicKey: pub,
      receiverId: USDC_CONTRACT,
      nonce: key.nonce + 2n,
      actions: storageActions,
      blockHash: key.blockHash,
    });
    (txs[0] as PlannedTx).txHash = tx1.hash;
    (txs[1] as PlannedTx).txHash = tx2.hash;

    if (!isLive(this.mode, this.o.signer !== undefined, opts))
      return { mode: 'dry_run', accountId, devicePublicKey: pk, txs };

    const signer = this.o.signer as TxSigner;
    const s1 = await signTx(tx1, signer);
    const o1 = await this.o.rpc.sendTx(s1.signedBase64, 'EXECUTED_OPTIMISTIC');
    const s2 = await signTx(tx2, signer);
    const o2 = await this.o.rpc.sendTx(s2.signedBase64, 'EXECUTED_OPTIMISTIC');
    return { mode: 'broadcast', accountId, devicePublicKey: pk, txs, outcomes: [o1, o2] };
  }
}

export interface AgentAccountPlan {
  accountId: string;
  signerId: string;
  initialBalanceNear: string;
  fullAccessKey: string;
  note: string;
}

/**
 * DRY plan for agent sub-accounts. Keys are generated offline by the operator
 * (e.g. `near generate-key`) and only PUBLIC keys are passed in. Never signs.
 */
export function planAgentAccounts(
  appAccountId: string,
  agentPublicKeys: Partial<Record<AgentName, string>>,
  initialBalanceYocto: bigint = 10n ** 22n,
): AgentAccountPlan[] {
  return AGENT_NAMES.map((name) => {
    const raw = agentPublicKeys[name];
    let key = '<GENERATE OFFLINE: near generate-key, pass PUBLIC key only>';
    if (raw) key = normalizeEd25519PublicKey(raw);
    return {
      accountId: `${name}.${appAccountId}`,
      signerId: appAccountId,
      initialBalanceNear: fromBaseUnits(initialBalanceYocto, 24),
      fullAccessKey: key,
      note: 'CreateAccount + Transfer + AddKey(FullAccess). Holds no user funds; signs nothing for users.',
    };
  });
}
