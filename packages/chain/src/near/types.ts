import { z } from 'zod';

/** Mirrors packages/shared schemas (NearAccountId, U64String, U128String, NearAction). Kept local to avoid coupling. */
export const NEAR_ACCOUNT_RE = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
export const NearAccountId = z.string().regex(NEAR_ACCOUNT_RE, 'not a valid NEAR account id');

export const U64_MAX = 18446744073709551615n;
export const U128_MAX = 340282366920938463463374607431768211455n;
export const U64String = z
  .string()
  .regex(/^(0|[1-9]\d{0,19})$/)
  .refine((s) => BigInt(s) <= U64_MAX, 'exceeds u64');
export const U128String = z
  .string()
  .regex(/^(0|[1-9]\d{0,38})$/)
  .refine((s) => BigInt(s) <= U128_MAX, 'exceeds u128');

const JsonValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValue),
    z.record(z.string(), JsonValue),
  ]),
);

export const FunctionCallSpec = z
  .object({
    type: z.literal('FunctionCall'),
    methodName: z.string().min(1).max(256),
    args: z.record(z.string(), JsonValue),
    gas: U64String,
    deposit: U128String,
  })
  .strict();
export const TransferSpec = z.object({ type: z.literal('Transfer'), deposit: U128String }).strict();
export const NearActionSpec = z.discriminatedUnion('type', [FunctionCallSpec, TransferSpec]);
export type NearActionSpec = z.infer<typeof NearActionSpec>;

/** The subset of an Approval (ARCHITECTURE.md) the device signs over. */
export const ApprovalSigningFields = z.object({
  signerId: NearAccountId,
  receiverId: NearAccountId,
  actions: z.array(NearActionSpec).min(1).max(8),
  nonce: U64String,
  maxBlockHeight: U64String,
});
export type ApprovalSigningFields = z.infer<typeof ApprovalSigningFields>;

export const ONE_YOCTO = 1n;
export const TGAS = 1_000_000_000_000n;
/** Protocol max prepaid gas per transaction (300 Tgas, raised to 1 Pgas in later protocol versions; we cap lower anyway). */
export const MAX_TX_GAS = 300n * TGAS;
export const YOCTO_PER_NEAR = 10n ** 24n;
/** Storage price: 1e19 yoctoNEAR per byte (10 bytes per 1e-4 NEAR). */
export const STORAGE_PRICE_PER_BYTE = 10n ** 19n;
