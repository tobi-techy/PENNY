import { z } from 'zod';
import { PasskeyRegistration } from './cards.ts';
import { DECIMAL_RE } from './decimal.ts';

// ---------- primitives ----------

export const Decimal = z.string().regex(DECIMAL_RE, 'must be a decimal like "12.50" (max 6 dp)');
export type Decimal = z.infer<typeof Decimal>;

/** NEAR account id rules (nomicon): 2..64 chars, lowercase, separators . _ - */
const NEAR_ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
export const NearAccountId = z
  .string()
  .min(2)
  .max(64)
  .regex(NEAR_ACCOUNT_RE, 'not a valid NEAR account id');
export type NearAccountId = z.infer<typeof NearAccountId>;

/** u64 / u128 as decimal strings, no leading zeros (except "0"). */
export const U64String = z
  .string()
  .regex(/^(0|[1-9]\d{0,19})$/)
  .refine((s) => BigInt(s) <= 18446744073709551615n, 'exceeds u64');
export const U128String = z
  .string()
  .regex(/^(0|[1-9]\d{0,38})$/)
  .refine((s) => BigInt(s) <= 340282366920938463463374607431768211455n, 'exceeds u128');

export const Ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/);
export const ApprovalId = z.string().regex(/^apr_[0-9A-HJKMNP-TV-Z]{26}$/);
export const UserId = z.string().regex(/^usr_[0-9A-HJKMNP-TV-Z]{26}$/);

export const Base64Url = z.string().regex(/^[A-Za-z0-9_-]+$/);
export const Base64 = z
  .string()
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
  .min(4);

// ---------- Intent plans (LLM fills these; deterministic code validates) ----------

export const InvestPlan = z
  .object({
    kind: z.literal('invest'),
    fromAsset: z.literal('USDC'),
    amountUsd: Decimal,
    portfolioId: z.string().min(1).max(128),
    quoteId: z.string().min(1).max(256),
  })
  .strict();

export const SendPlan = z
  .object({
    kind: z.literal('send'),
    asset: z.enum(['USDC', 'NEAR']),
    amount: Decimal,
    to: NearAccountId,
    note: z.string().max(280).optional(),
  })
  .strict();

export const PayBillPlan = z
  .object({
    kind: z.literal('pay_bill'),
    billId: z.string().min(1).max(128),
    payee: z.string().min(1).max(128),
    amount: Decimal,
    /** USDC on mainnet; NEAR on testnet, where there is no USDC to pay with. */
    asset: z.enum(['USDC', 'NEAR']),
  })
  .strict();

export const ErrandPlan = z
  .object({
    kind: z.literal('errand'),
    taskId: z.string().min(1).max(128),
    bidId: z.string().min(1).max(128),
    amount: Decimal,
    asset: z.literal('USDC'),
  })
  .strict();

export const SplitPlan = z
  .object({
    kind: z.literal('split'),
    total: Decimal,
    participants: z
      .array(z.object({ handle: z.string().min(1).max(64), share: Decimal }).strict())
      .min(2)
      .max(20),
  })
  .strict();

// ---------- Bots (user-created crew members are data, not code) ----------

export const ToolRisk = z.enum(['read', 'write', 'money']);
export type ToolRisk = z.infer<typeof ToolRisk>;

export const BotSlug = z
  .string()
  .min(2)
  .max(32)
  .regex(/^[a-z][a-z0-9-]*[a-z0-9]$/, 'lowercase letters, digits and dashes');
export const ToolId = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/);

export const BotPermissions = z
  .object({
    canMoveMoney: z.boolean().default(false),
    perTxCap: Decimal.optional(),
    dailyCap: Decimal.optional(),
  })
  .strict();
export type BotPermissions = z.infer<typeof BotPermissions>;

export const CreateBotPlan = z
  .object({
    kind: z.literal('create_bot'),
    slug: BotSlug,
    name: z.string().min(1).max(40),
    soulMd: z.string().min(20).max(6000),
    toolIds: z.array(ToolId).max(24),
    permissions: BotPermissions,
  })
  .strict();
export type CreateBotPlan = z.infer<typeof CreateBotPlan>;

/**
 * A write action in an outside app (send an email, post a comment, book a
 * thing) proposed by a bot. Executed by the engine only after Face ID
 * approval, through the connector layer. Never money.
 */
export const WritePlan = z
  .object({
    kind: z.literal('write'),
    toolkit: z
      .string()
      .min(2)
      .max(32)
      .regex(/^[a-z][a-z0-9-]*$/),
    toolSlug: z
      .string()
      .min(3)
      .max(80)
      .regex(/^[A-Z][A-Z0-9_]+$/),
    title: z.string().min(1).max(80),
    summary: z.string().min(1).max(300),
    arguments: z.record(z.string(), z.unknown()),
  })
  .strict();
export type WritePlan = z.infer<typeof WritePlan>;

export const IntentPlan = z.discriminatedUnion('kind', [
  InvestPlan,
  SendPlan,
  PayBillPlan,
  ErrandPlan,
  SplitPlan,
  CreateBotPlan,
  WritePlan,
]);
export type IntentPlan = z.infer<typeof IntentPlan>;
export type IntentKind = IntentPlan['kind'];

/** Plans that move money. `split`, `create_bot` and `write` never move money. */
export type MoneyPlan = Exclude<
  IntentPlan,
  { kind: 'split' } | { kind: 'create_bot' } | { kind: 'write' }
>;
export function isMoneyPlan(p: IntentPlan): p is MoneyPlan {
  return p.kind !== 'split' && p.kind !== 'create_bot' && p.kind !== 'write';
}

/** USD-equivalent amount a plan moves, as a Decimal string. NEAR needs a price. */
export function planAmount(p: MoneyPlan): { asset: 'USDC' | 'NEAR'; amount: string } {
  switch (p.kind) {
    case 'invest':
      return { asset: 'USDC', amount: p.amountUsd };
    case 'send':
      return { asset: p.asset, amount: p.amount };
    case 'pay_bill':
      return { asset: p.asset, amount: p.amount };
    case 'errand':
      return { asset: 'USDC', amount: p.amount };
  }
}

export function planRecipient(p: MoneyPlan): string | null {
  switch (p.kind) {
    case 'send':
      return p.to;
    case 'pay_bill':
      return `bill:${p.payee}`;
    case 'errand':
      return `errand:${p.taskId}`;
    case 'invest':
      return null;
  }
}

// ---------- NEAR actions ----------

const JsonValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValue),
    z.record(z.string(), JsonValue),
  ]),
);

export const FunctionCallAction = z
  .object({
    type: z.literal('FunctionCall'),
    methodName: z.string().min(1).max(256),
    args: z.record(z.string(), JsonValue),
    gas: U64String,
    deposit: U128String,
  })
  .strict();

export const TransferAction = z
  .object({
    type: z.literal('Transfer'),
    deposit: U128String,
  })
  .strict();

export const NearAction = z.discriminatedUnion('type', [FunctionCallAction, TransferAction]);
export type NearAction = z.infer<typeof NearAction>;

// ---------- Approval ----------

export const ApprovalStatus = z.enum([
  'pending',
  'signed',
  'relayed',
  'settled',
  'failed',
  'expired',
  'cancelled',
]);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

export const Fact = z.object({ label: z.string().max(40), value: z.string().max(80) }).strict();

export const ApprovalKind = z.enum(['invest', 'send', 'pay_bill', 'errand', 'create_bot', 'write']);
export type ApprovalKind = z.infer<typeof ApprovalKind>;

/**
 * Message the device signs (ed25519, enrolled key) for approvals that carry no
 * NEAR actions, e.g. create_bot. PROPOSED contract addition (v0.1 doc has none).
 */
export function planApprovalMessage(approvalId: string, planHashValue: string): string {
  return `penny-approval:v1:${approvalId}:${planHashValue}`;
}

/** Messages the enrolled device signs (ed25519) for account-level operations. */
export function deviceRevokeMessage(
  accountId: string,
  deviceId: string,
  timestampSec: number,
): string {
  return `penny-device:revoke:v1:${accountId}:${deviceId}:${timestampSec}`;
}
export function policyUpdateMessage(
  accountId: string,
  perTxUsd: string,
  dailyUsd: string,
  blockNewRecipientsOverUsd: string,
  timestampSec: number,
): string {
  return `penny-policy:v1:${accountId}:${perTxUsd}:${dailyUsd}:${blockNewRecipientsOverUsd}:${timestampSec}`;
}
export function historyRequestMessage(accountId: string, timestampSec: number): string {
  return `penny-history:v1:${accountId}:${timestampSec}`;
}

export const Approval = z
  .object({
    id: ApprovalId,
    userId: UserId,
    kind: ApprovalKind,
    /** The exact plan that was hashed. Devices recompute planHash from this. */
    plan: IntentPlan,
    title: z.string().min(1).max(80),
    amountDisplay: z.string().min(1).max(40),
    facts: z.array(Fact).max(8),
    signerId: NearAccountId,
    receiverId: NearAccountId,
    actions: z.array(NearAction).max(8),
    nonce: U64String,
    maxBlockHeight: U64String,
    expiresAt: z.iso.datetime(),
    status: ApprovalStatus,
    planHash: Base64Url.length(43),
  })
  .strict()
  .refine(
    (a) =>
      a.kind === 'create_bot' || a.kind === 'write'
        ? a.actions.length === 0
        : a.actions.length >= 1,
    {
      message: 'money approvals need at least one action; create_bot/write approvals carry none',
      path: ['actions'],
    },
  );
export type Approval = z.infer<typeof Approval>;

// ---------- Engine HTTP API bodies ----------

export const ENROLL_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
export const EnrollCode = z
  .string()
  .length(8)
  .regex(/^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{8}$/);

export const EnrollBody = z
  .object({
    enrollCode: EnrollCode,
    /** base64url, exactly 32 raw bytes (43 chars, unpadded) */
    publicKeyEd25519: Base64Url.length(43),
    appAttest: z.string().max(16_384).optional(),
    appAttestChallengeId: z.string().min(3).max(64).optional(),
    /** ios_app (default, has the iMessage extension) or web_passkey (no install). */
    platform: z.enum(['ios_app', 'web_passkey']).optional(),
    /** web_passkey: the passkey made on this phone, checked on the server. */
    passkey: PasskeyRegistration.optional(),
    passkeyChallengeId: z.string().min(3).max(64).optional(),
  })
  .strict()
  .refine((b) => b.platform !== 'web_passkey' || (b.passkey && b.passkeyChallengeId), {
    message: 'web_passkey enrollment needs a passkey',
    path: ['passkey'],
  });
export type EnrollBody = z.infer<typeof EnrollBody>;

export const EnrollResponse = z
  .object({
    userId: UserId,
    accountId: NearAccountId,
    deviceId: z.string().min(3).max(64),
    status: z.enum(['created', 'dry_run']),
  })
  .strict();

export const SubmitBody = z.union([
  z
    .object({
      /** base64 (standard, padded) borsh-encoded NEP-366 SignedDelegateAction */
      signedDelegateAction: Base64.max(16_384),
    })
    .strict(),
  z
    .object({
      /** base64url ed25519 signature (64 bytes) over planApprovalMessage(). create_bot only. */
      planSignature: Base64Url.length(86),
    })
    .strict(),
]);
export type SubmitBody = z.infer<typeof SubmitBody>;

export const DeclineBody = z.object({ reason: z.string().max(140).optional() }).strict();

export const StatusStep = z
  .object({
    label: z.string(),
    state: z.enum(['todo', 'active', 'done', 'failed']),
  })
  .strict();

export const ApprovalStatusResponse = z
  .object({
    id: ApprovalId,
    status: ApprovalStatus,
    txHash: z.string().nullable(),
    steps: z.array(StatusStep),
  })
  .strict();
export type ApprovalStatusResponse = z.infer<typeof ApprovalStatusResponse>;

// ---------- Photon / Spectrum webhook (Stable) ----------
// Forward-compatible: unknown fields tolerated, unknown content types allowed.

const SpectrumSpace = z.looseObject({
  id: z.string().min(1),
  platform: z.string().min(1),
  type: z.string().optional(),
  phone: z.string().optional(),
});

const SpectrumContent = z.looseObject({ type: z.string(), text: z.string().optional() });

export const SpectrumMessagesEvent = z.looseObject({
  event: z.literal('messages'),
  space: SpectrumSpace,
  message: z.looseObject({
    id: z.string().min(1).max(512),
    platform: z.string(),
    direction: z.string(),
    timestamp: z.string(),
    sender: z.looseObject({ id: z.string().min(1), platform: z.string() }),
    space: SpectrumSpace.optional(),
    content: SpectrumContent,
  }),
});
export type SpectrumMessagesEvent = z.infer<typeof SpectrumMessagesEvent>;
