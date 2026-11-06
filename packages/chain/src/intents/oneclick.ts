import { z } from 'zod';
import { USDC_STORAGE_DEPOSIT } from '../near/ft.ts';
import { NEAR_ACCOUNT_RE, type NearActionSpec, TGAS } from '../near/types.ts';
import { type FetchLike, fetchJson } from '../util/http.ts';

/** OpenAPI: https://1click.chaindefuser.com/docs/v0/openapi.yaml (servers[0]). */
export const ONECLICK_BASE_URL = 'https://1click.chaindefuser.com';
/** SECURITY.md: quote expiry <= 120 s. */
export const MAX_QUOTE_TTL_MS = 120_000;

const IntString = z.string().regex(/^\d+$/);
const IsoDate = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'not a date');

export const TokenSchema = z.object({
  assetId: z.string(),
  decimals: z.number().int().min(0).max(38),
  blockchain: z.string(),
  symbol: z.string(),
  price: z.number(),
  priceUpdatedAt: IsoDate,
  contractAddress: z.string().optional(),
  coingeckoId: z.string().optional(),
});
export type OneClickToken = z.infer<typeof TokenSchema>;

const SwapType = z.enum(['EXACT_INPUT', 'EXACT_OUTPUT', 'FLEX_INPUT', 'ANY_INPUT']);
const DepositType = z.enum(['ORIGIN_CHAIN', 'INTENTS', 'CONFIDENTIAL_INTENTS']);
const RecipientType = z.enum(['DESTINATION_CHAIN', 'INTENTS', 'CONFIDENTIAL_INTENTS']);

export const QuoteResponseSchema = z.object({
  correlationId: z.string(),
  timestamp: IsoDate,
  signature: z.string(),
  quoteRequest: z
    .object({
      dry: z.boolean(),
      swapType: SwapType,
      slippageTolerance: z.number(),
      originAsset: z.string(),
      depositType: DepositType,
      destinationAsset: z.string(),
      amount: IntString,
      refundTo: z.string(),
      refundType: DepositType,
      recipient: z.string(),
      recipientType: RecipientType,
      deadline: IsoDate,
    })
    .passthrough(),
  quote: z.object({
    depositAddress: z.string().optional(),
    depositMemo: z.string().optional(),
    amountIn: IntString,
    amountInFormatted: z.string(),
    amountInUsd: z.string(),
    minAmountIn: IntString,
    amountOut: IntString,
    amountOutFormatted: z.string(),
    amountOutUsd: z.string(),
    minAmountOut: IntString,
    deadline: IsoDate.optional(),
    timeWhenInactive: IsoDate.optional(),
    timeEstimate: z.number(),
    refundFee: IntString.optional(),
    withdrawFee: IntString.optional(),
  }),
});
export type QuoteResponse = z.infer<typeof QuoteResponseSchema>;

export const STATUS_VALUES = [
  'KNOWN_DEPOSIT_TX',
  'PENDING_DEPOSIT',
  'INCOMPLETE_DEPOSIT',
  'PROCESSING',
  'SUCCESS',
  'REFUNDED',
  'FAILED',
] as const;
export const StatusSchema = z.object({
  correlationId: z.string(),
  // The echoed quote in /v0/status has no correlationId of its own (observed live 2026-11-06).
  quoteResponse: QuoteResponseSchema.extend({ correlationId: z.string().optional() }),
  status: z.enum(STATUS_VALUES),
  updatedAt: IsoDate,
  swapDetails: z
    .object({
      // 1Click returns null (not absent) for fields it has not filled yet (observed live 2026-11-06).
      intentHashes: z.array(z.string()).nullish(),
      nearTxHashes: z.array(z.string()).nullish(),
      originChainTxHashes: z.array(z.unknown()).nullish(),
      destinationChainTxHashes: z.array(z.unknown()).nullish(),
      amountIn: IntString.nullish(),
      amountInFormatted: z.string().nullish(),
      amountOut: IntString.nullish(),
      amountOutFormatted: z.string().nullish(),
      refundedAmount: IntString.nullish(),
      refundedAmountFormatted: z.string().nullish(),
      refundReason: z.string().nullish(),
    })
    .passthrough(),
});
export type SwapStatus = z.infer<typeof StatusSchema>;
export type SwapStatusValue = (typeof STATUS_VALUES)[number];

/** 1Click statuses the swap can still leave. */
export function isTerminalSwapStatus(s: SwapStatusValue): boolean {
  return s === 'SUCCESS' || s === 'REFUNDED' || s === 'FAILED';
}

/** Explorer pages for a swap: NEAR Intents explorer by deposit address, nearblocks for the deposit tx. */
export function swapExplorerLinks(depositAddress: string, depositTxHash?: string) {
  return {
    intents: `https://explorer.near-intents.org/transactions/${encodeURIComponent(depositAddress)}`,
    ...(depositTxHash ? { nearTx: `https://nearblocks.io/txns/${encodeURIComponent(depositTxHash)}` } : {}),
  };
}

/**
 * Partner/app fee in bps that 1Click put on the quote (quoteRequest.appFees).
 * Without an API key or JWT, 1Click adds a 20 bps (0.2%) fee here (observed live 2026-11-06).
 */
export function quoteFeeBps(res: QuoteResponse): number {
  const fees = (res.quoteRequest as { appFees?: unknown }).appFees;
  if (!Array.isArray(fees)) return 0;
  let bps = 0;
  for (const f of fees) {
    if (!f || typeof f !== 'object') continue;
    const v = (f as { fee?: unknown }).fee;
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0) bps += v;
  }
  return bps;
}

export interface QuoteParams {
  dry: boolean;
  originAsset: string;
  destinationAsset: string;
  /** Base units, bigint only. */
  amount: bigint;
  slippageBps: number;
  recipient: string;
  recipientType?: z.infer<typeof RecipientType>;
  refundTo: string;
  refundType?: z.infer<typeof DepositType>;
  depositType?: z.infer<typeof DepositType>;
  swapType?: 'EXACT_INPUT';
  /** When 1Click starts refunding if unfilled. Default now + 10 min. */
  deadline?: Date;
  referral?: string;
  quoteWaitingTimeMs?: number;
}

export interface QuoteChecks {
  /** Reject if the guaranteed output is below this (base units of destination asset). */
  minReceived?: bigint;
  /** Hard cap on accepted slippage (bps); default 300 = 3%. */
  maxSlippageBps?: number;
}

export interface ValidatedQuote {
  response: QuoteResponse;
  amountIn: bigint;
  amountOut: bigint;
  minAmountOut: bigint;
  depositAddress?: string;
  depositMemo?: string;
  /** min(now + 120 s, 1Click deadline). Approval.expiresAt must be <= this. */
  expiresAt: Date;
}

export class QuoteRejected extends Error {
  override name = 'QuoteRejected';
  constructor(
    message: string,
    readonly code:
      | 'BAD_PARAMS'
      | 'ECHO_MISMATCH'
      | 'AMOUNT_IN_MISMATCH'
      | 'SLIPPAGE_BOUND'
      | 'MIN_RECEIVED'
      | 'MISSING_DEPOSIT_ADDRESS'
      | 'EXPIRED'
      | 'UNSUPPORTED_DEPOSIT',
  ) {
    super(message);
  }
}

export interface OneClickOptions {
  /** Optional partner key (X-API-Key header). Without it 1Click adds an extra fee (docs: "Making a Request"). */
  apiKey?: string;
  /** Legacy bearer JWT. */
  jwt?: string;
  baseUrl?: string;
  fetch?: FetchLike;
  now?: () => Date;
  timeoutMs?: number;
}

export class OneClickClient {
  /** True when requests carry an API key or JWT (no keyless 0.2% fee). */
  get authenticated(): boolean {
    return Boolean(this.o.apiKey || this.o.jwt);
  }
  private readonly base: string;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;

  constructor(private readonly o: OneClickOptions = {}) {
    this.base = o.baseUrl ?? ONECLICK_BASE_URL;
    this.fetchImpl = o.fetch ?? ((i, init) => fetch(i, init));
    this.now = o.now ?? (() => new Date());
  }

  private headers(): Record<string, string> {
    if (this.o.apiKey) return { 'X-API-Key': this.o.apiKey };
    if (this.o.jwt) return { authorization: `Bearer ${this.o.jwt}` };
    return {};
  }

  getTokens(): Promise<OneClickToken[]> {
    return fetchJson(this.fetchImpl, `${this.base}/v0/tokens`, z.array(TokenSchema), {
      headers: this.headers(),
      timeoutMs: this.o.timeoutMs,
    });
  }

  async quote(p: QuoteParams, checks: QuoteChecks = {}): Promise<ValidatedQuote> {
    const maxSlip = checks.maxSlippageBps ?? 300;
    if (!Number.isInteger(p.slippageBps) || p.slippageBps < 0 || p.slippageBps > maxSlip) {
      throw new QuoteRejected(`slippage ${p.slippageBps} bps outside 0..${maxSlip}`, 'BAD_PARAMS');
    }
    if (p.amount <= 0n) throw new QuoteRejected('amount must be positive', 'BAD_PARAMS');
    const now = this.now();
    const body = {
      dry: p.dry,
      swapType: p.swapType ?? 'EXACT_INPUT',
      slippageTolerance: p.slippageBps,
      originAsset: p.originAsset,
      depositType: p.depositType ?? 'ORIGIN_CHAIN',
      destinationAsset: p.destinationAsset,
      amount: p.amount.toString(),
      refundTo: p.refundTo,
      refundType: p.refundType ?? 'ORIGIN_CHAIN',
      recipient: p.recipient,
      recipientType: p.recipientType ?? 'DESTINATION_CHAIN',
      deadline: (p.deadline ?? new Date(now.getTime() + 10 * 60_000)).toISOString(),
      ...(p.referral ? { referral: p.referral } : {}),
      ...(p.quoteWaitingTimeMs !== undefined ? { quoteWaitingTimeMs: p.quoteWaitingTimeMs } : {}),
    };
    const res = await fetchJson(this.fetchImpl, `${this.base}/v0/quote`, QuoteResponseSchema, {
      method: 'POST',
      body,
      headers: this.headers(),
      timeoutMs: this.o.timeoutMs ?? 30_000,
    });
    return validateQuote(res, body, checks, now);
  }

  status(depositAddress: string, depositMemo?: string): Promise<SwapStatus> {
    const q = new URLSearchParams({ depositAddress });
    if (depositMemo) q.set('depositMemo', depositMemo);
    return fetchJson(this.fetchImpl, `${this.base}/v0/status?${q}`, StatusSchema, {
      headers: this.headers(),
      timeoutMs: this.o.timeoutMs,
    });
  }

  /**
   * POST /v0/deposit/submit: optional hint that the deposit tx was sent (speeds up processing).
   * For NEAR deposits pass nearSenderAccount = the user's account (the delegate sender).
   */
  submitDeposit(p: {
    txHash: string;
    depositAddress: string;
    nearSenderAccount?: string;
    memo?: string;
  }): Promise<SwapStatus> {
    return fetchJson(this.fetchImpl, `${this.base}/v0/deposit/submit`, StatusSchema, {
      method: 'POST',
      body: {
        txHash: p.txHash,
        depositAddress: p.depositAddress,
        ...(p.nearSenderAccount ? { nearSenderAccount: p.nearSenderAccount } : {}),
        ...(p.memo ? { memo: p.memo } : {}),
      },
      headers: this.headers(),
      timeoutMs: this.o.timeoutMs,
    });
  }
}

/** Exported for tests and for re-validating a stored quote. */
export function validateQuote(
  res: QuoteResponse,
  sent: {
    dry: boolean;
    swapType: string;
    originAsset: string;
    destinationAsset: string;
    amount: string;
    recipient: string;
    refundTo: string;
    slippageTolerance: number;
  },
  checks: QuoteChecks,
  now: Date,
): ValidatedQuote {
  const r = res.quoteRequest;
  for (const k of [
    'dry',
    'swapType',
    'originAsset',
    'destinationAsset',
    'amount',
    'recipient',
    'refundTo',
    'slippageTolerance',
  ] as const) {
    if (r[k] !== sent[k])
      throw new QuoteRejected(`quoteRequest.${k} echo mismatch`, 'ECHO_MISMATCH');
  }
  const amountIn = BigInt(res.quote.amountIn);
  const amountOut = BigInt(res.quote.amountOut);
  const minAmountOut = BigInt(res.quote.minAmountOut);
  if (sent.swapType === 'EXACT_INPUT' && amountIn !== BigInt(sent.amount)) {
    throw new QuoteRejected(
      `amountIn ${amountIn} != requested ${sent.amount}`,
      'AMOUNT_IN_MISMATCH',
    );
  }
  // minAmountOut must sit within the slippage we asked for: min >= floor(out * (10000 - bps) / 10000), never above out.
  // (1Click floors the product; observed live 2026-11-05.)
  const bps = BigInt(sent.slippageTolerance);
  const floorMin = (amountOut * (10_000n - bps)) / 10_000n;
  if (minAmountOut > amountOut || minAmountOut < floorMin) {
    throw new QuoteRejected(
      `minAmountOut ${minAmountOut} outside slippage bound of ${amountOut}`,
      'SLIPPAGE_BOUND',
    );
  }
  if (checks.minReceived !== undefined && minAmountOut < checks.minReceived) {
    throw new QuoteRejected(
      `minAmountOut ${minAmountOut} < minReceived ${checks.minReceived}`,
      'MIN_RECEIVED',
    );
  }
  let expiresAt = new Date(now.getTime() + MAX_QUOTE_TTL_MS);
  if (!sent.dry) {
    if (!res.quote.depositAddress)
      throw new QuoteRejected('live quote without depositAddress', 'MISSING_DEPOSIT_ADDRESS');
    if (!res.quote.deadline)
      throw new QuoteRejected('live quote without deadline', 'MISSING_DEPOSIT_ADDRESS');
    const deadline = new Date(res.quote.deadline);
    if (deadline.getTime() <= now.getTime())
      throw new QuoteRejected('quote deadline already passed', 'EXPIRED');
    if (deadline < expiresAt) expiresAt = deadline;
  }
  return {
    response: res,
    amountIn,
    amountOut,
    minAmountOut,
    ...(res.quote.depositAddress ? { depositAddress: res.quote.depositAddress } : {}),
    ...(res.quote.depositMemo ? { depositMemo: res.quote.depositMemo } : {}),
    expiresAt,
  };
}

export function isQuoteFresh(q: ValidatedQuote, now: Date = new Date()): boolean {
  return now.getTime() < q.expiresAt.getTime();
}

export interface DepositPlan {
  /** The NEP-141 token contract: the delegate action's receiverId. */
  receiverId: string;
  actions: NearActionSpec[];
}

/**
 * Actions the user signs (as one NEP-366 delegate) to fund an ORIGIN_CHAIN quote whose
 * origin asset is a NEAR NEP-141 token. Per 1Click docs, ORIGIN_CHAIN deposits are a plain
 * transfer of `amountIn` to `depositAddress`; on NEAR that is `ft_transfer`, preceded by
 * `storage_deposit` if the deposit address is not yet registered on the token.
 * (ft_transfer_call to a deposit address would call ft_on_transfer on an account with no
 * contract and be refunded; ft_transfer_call is only for depositing into intents.near.)
 */
export function buildDepositActions(
  q: ValidatedQuote,
  opts: { depositAddressRegistered: boolean; storageDepositYocto?: bigint; ftTransferGas?: bigint },
): DepositPlan {
  const req = q.response.quoteRequest;
  if (req.dry)
    throw new QuoteRejected('cannot build deposit for a dry quote', 'UNSUPPORTED_DEPOSIT');
  if (req.depositType !== 'ORIGIN_CHAIN')
    throw new QuoteRejected(`depositType ${req.depositType} unsupported`, 'UNSUPPORTED_DEPOSIT');
  if (!req.originAsset.startsWith('nep141:'))
    throw new QuoteRejected('origin asset is not a NEAR NEP-141 token', 'UNSUPPORTED_DEPOSIT');
  if (q.depositMemo)
    throw new QuoteRejected('memo deposits unsupported on NEAR', 'UNSUPPORTED_DEPOSIT');
  const to = q.depositAddress;
  if (!to || !NEAR_ACCOUNT_RE.test(to))
    throw new QuoteRejected('deposit address is not a NEAR account', 'MISSING_DEPOSIT_ADDRESS');
  const token = req.originAsset.slice('nep141:'.length);
  if (!NEAR_ACCOUNT_RE.test(token))
    throw new QuoteRejected('bad token contract', 'UNSUPPORTED_DEPOSIT');

  const actions: NearActionSpec[] = [];
  if (!opts.depositAddressRegistered) {
    actions.push({
      type: 'FunctionCall',
      methodName: 'storage_deposit',
      args: { account_id: to, registration_only: true },
      gas: (10n * TGAS).toString(),
      deposit: (opts.storageDepositYocto ?? USDC_STORAGE_DEPOSIT).toString(),
    });
  }
  actions.push({
    type: 'FunctionCall',
    methodName: 'ft_transfer',
    args: { receiver_id: to, amount: q.amountIn.toString() },
    gas: (opts.ftTransferGas ?? 30n * TGAS).toString(),
    deposit: '1',
  });
  return { receiverId: token, actions };
}
