import { z } from 'zod';
import { isValidTimeZone } from './bills/time.ts';

const flag = z.enum(['0', '1']);
const optionalStr = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v));

/**
 * Engine environment. Parsed once at boot, fails closed.
 * Mainnet requires every secret. Relay is live only when
 * PENNY_ENV=mainnet AND DRY_RUN=0 AND a relayer key is present (SECURITY.md).
 */
const BaseEnv = z.object({
  PENNY_ENV: z.enum(['dev', 'mainnet']).default('dev'),
  DRY_RUN: flag.default('1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  PUBLIC_BASE_URL: z.url().default('http://localhost:8787'),
  /** IANA zone for "now" in prompts and reminder times (bill reminders at 09:00 local). */
  PENNY_TIMEZONE: z
    .string()
    .default('Africa/Lagos')
    .refine(isValidTimeZone, 'must be an IANA time zone like Africa/Lagos'),
  /**
   * NEAR account you control that receives USDC for the "Penny Demo Utility" biller.
   * Unset = no demo biller; real billers get payout accounts in bills/billers.ts.
   */
  PENNY_DEMO_BILLER_ACCOUNT: optionalStr.refine(
    (v) => v === undefined || /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(v),
    'must be a NEAR account id',
  ),
  DATABASE_URL: optionalStr,

  SPECTRUM_PROJECT_ID: optionalStr,
  /** Filled from SPECTRUM_SECRET (preferred name) when set. */
  SPECTRUM_PROJECT_SECRET: optionalStr,
  SPECTRUM_WEBHOOK_SECRET: optionalStr,
  IMESSAGE_APP_NAME: z.string().default('Penny'),
  /** Filled from PENNY_IMESSAGE_EXT_BUNDLE_ID (preferred name) when set. */
  IMESSAGE_EXTENSION_BUNDLE_ID: z.string().default('money.penny.host.messages'),
  /** Filled from APPLE_TEAM_ID (preferred name) when set. */
  IMESSAGE_TEAM_ID: optionalStr,
  /** The host app's bundle id; with APPLE_TEAM_ID it gives the App Attest app id. */
  PENNY_IOS_BUNDLE_ID: optionalStr,

  NEARAI_BASE_URL: z.url().default('https://cloud-api.near.ai/v1'),
  NEARAI_API_KEY: optionalStr,
  NEARAI_MODEL: z.string().default('z-ai/glm-5.3-flash'),
  NEARAI_ROUTER_MODEL: z.string().default('z-ai/glm-5.3-flash'),
  NEARAI_EMBEDDING_MODEL: z.string().default('Qwen/Qwen3-Embedding-0.6B'),
  /** TEE attestation of NEAR AI Cloud (docs/TEE.md). off = unchanged behaviour. */
  NEARAI_ATTESTATION: z.enum(['off', 'warn', 'enforce']).default('off'),
  NEARAI_ATTESTATION_TTL_SEC: z.coerce.number().int().min(30).max(3600).default(300),

  COMPOSIO_API_KEY: optionalStr,
  /** Composio Firewall hooks are a paid-plan feature; off unless set to 1. */
  COMPOSIO_FIREWALL: flag.default('0'),

  /** "TEAMID.bundle.id" for App Attest verification, e.g. A1B2C3D4E5.app.penny.host */
  APP_ATTEST_APP_ID: optionalStr,

  NEAR_NETWORK: z.enum(['mainnet', 'testnet']).default('testnet'),
  NEAR_APP_ACCOUNT_ID: z.string().default('penny.near'),
  NEAR_RELAYER_ACCOUNT_ID: optionalStr,
  NEAR_RELAYER_PRIVATE_KEY: optionalStr,
  NEAR_RPC_URL: optionalStr,
  NEAR_RELAYER_PUBLIC_KEY: optionalStr,
  NEAR_APP_PRIVATE_KEY: optionalStr,
  NEAR_APP_PUBLIC_KEY: optionalStr,
  /**
   * Testnet only: the dollar token accounts are registered with (tUSD). Unset on
   * mainnet, where the adapter always uses native USDC.
   */
  NEAR_USDC_CONTRACT: optionalStr.refine(
    (v) => v === undefined || /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(v),
    'must be a NEAR account id',
  ),
  /**
   * The single shared Guard contract (contracts/guard), e.g. guard.penny.testnet.
   * Unset = the shared Guard check is off and guardFor() returns undefined.
   */
  PENNY_GUARD_CONTRACT: optionalStr.refine(
    (v) => v === undefined || /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(v),
    'must be a NEAR account id',
  ),
  ONECLICK_API_KEY: optionalStr,
  /** Optional 1Click JWT. Without a key or JWT 1Click adds a 0.2% fee (shown on the card). */
  ONECLICK_JWT: optionalStr,
  /** Invest slippage tolerance in bps (1Click quote). */
  INVEST_SLIPPAGE_BPS: z.coerce.number().int().min(1).max(300).default(100),
  /** Env hard ceiling on NEAR the relayer fronts for one approval (inner deposits). */
  PENNY_RELAYER_MAX_DEPOSIT_NEAR: z
    .string()
    .regex(/^\d+(\.\d{1,24})?$/)
    .default('1'),
  GLIDER_API_KEY: optionalStr,
  /** Set to 1 only after the testnet end-to-end runbook passes. Gates mainnet boot. */
  PENNY_TESTNET_E2E_OK: flag.default('0'),
  /** Hard per-tx ceiling applied on mainnet regardless of user policy. */
  PENNY_MAINNET_MAX_PER_TX_USD: z
    .string()
    .regex(/^\d+(\.\d{1,6})?$/)
    .default('25'),
  /** Hard daily-total ceiling applied on mainnet regardless of user policy. */
  PENNY_MAINNET_MAX_DAILY_USD: z
    .string()
    .regex(/^\d+(\.\d{1,6})?$/)
    .default('50'),

  LANGFUSE_PUBLIC_KEY: optionalStr,
  LANGFUSE_SECRET_KEY: optionalStr,
  LANGFUSE_BASE_URL: z.url().default('https://cloud.langfuse.com'),

  /** Turns on the testnet proof routes for `bun run prove`. Refused on mainnet. */
  PENNY_PROVE_SECRET: optionalStr,

  RATE_LIMIT_PER_IP_PER_MIN: z.coerce.number().int().positive().default(120),
  RATE_LIMIT_PER_USER_PER_MIN: z.coerce.number().int().positive().default(30),
  MAX_BODY_BYTES: z.coerce.number().int().positive().max(1_048_576).default(65_536),
});

const MAINNET_REQUIRED = [
  'DATABASE_URL',
  'SPECTRUM_PROJECT_ID',
  'SPECTRUM_PROJECT_SECRET',
  'SPECTRUM_WEBHOOK_SECRET',
  'IMESSAGE_TEAM_ID',
  'NEARAI_API_KEY',
  'NEAR_RELAYER_ACCOUNT_ID',
  'NEAR_RELAYER_PRIVATE_KEY',
  'NEAR_RPC_URL',
] as const;

export const EnvSchema = BaseEnv.superRefine((env, ctx) => {
  // The test dollar override exists for testnet only; mainnet always moves USDC.
  if (env.NEAR_USDC_CONTRACT && env.NEAR_NETWORK === 'mainnet') {
    ctx.addIssue({
      code: 'custom',
      path: ['NEAR_USDC_CONTRACT'],
      message: 'NEAR_USDC_CONTRACT may only be set on testnet',
    });
  }
  if (env.NEAR_USDC_CONTRACT && env.PENNY_ENV === 'mainnet') {
    ctx.addIssue({
      code: 'custom',
      path: ['NEAR_USDC_CONTRACT'],
      message: 'NEAR_USDC_CONTRACT may only be set on testnet',
    });
  }
  if (env.PENNY_PROVE_SECRET && (env.PENNY_ENV === 'mainnet' || env.NEAR_NETWORK !== 'testnet')) {
    ctx.addIssue({
      code: 'custom',
      path: ['PENNY_PROVE_SECRET'],
      message: 'the proof routes are testnet only',
    });
  }
  if (env.PENNY_PROVE_SECRET && env.PENNY_PROVE_SECRET.length < 32) {
    ctx.addIssue({
      code: 'custom',
      path: ['PENNY_PROVE_SECRET'],
      message: 'use at least 32 characters',
    });
  }
  // Card links and passkeys (origin + rpId) are built from PUBLIC_BASE_URL, never from a
  // request's Host header, so a live engine must say where it lives.
  if (env.SPECTRUM_PROJECT_ID && !env.PUBLIC_BASE_URL.startsWith('https://')) {
    ctx.addIssue({
      code: 'custom',
      path: ['PUBLIC_BASE_URL'],
      message: 'set PUBLIC_BASE_URL to the public https URL when Spectrum is configured',
    });
  }
  if (env.PENNY_ENV !== 'mainnet') return;
  for (const key of MAINNET_REQUIRED) {
    if (!env[key]) {
      ctx.addIssue({
        code: 'custom',
        path: [key],
        message: `${key} is required when PENNY_ENV=mainnet`,
      });
    }
  }
  if (env.NEAR_NETWORK !== 'mainnet') {
    ctx.addIssue({
      code: 'custom',
      path: ['NEAR_NETWORK'],
      message: 'mainnet env must use NEAR_NETWORK=mainnet',
    });
  }
  if (!env.PUBLIC_BASE_URL.startsWith('https://')) {
    ctx.addIssue({ code: 'custom', path: ['PUBLIC_BASE_URL'], message: 'mainnet requires https' });
  }
});

export type Env = z.infer<typeof EnvSchema> & { readonly relayLive: boolean };

export class EnvError extends Error {
  override name = 'EnvError';
}

/** Parse env or throw. Error lists only key names, never values. */
/** Preferred env names (live cards) -> the names the engine reads. Old names still work. */
const ALIASES: [preferred: string, legacy: string][] = [
  ['SPECTRUM_SECRET', 'SPECTRUM_PROJECT_SECRET'],
  ['APPLE_TEAM_ID', 'IMESSAGE_TEAM_ID'],
  ['PENNY_IMESSAGE_EXT_BUNDLE_ID', 'IMESSAGE_EXTENSION_BUNDLE_ID'],
];

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const merged: Record<string, string | undefined> = { ...source };
  for (const [preferred, legacy] of ALIASES) {
    const v = source[preferred];
    if (v !== undefined && v.trim() !== '') merged[legacy] = v;
  }
  // App Attest app id = TEAMID.bundle.id when not given directly
  if (!merged.APP_ATTEST_APP_ID && merged.IMESSAGE_TEAM_ID && merged.PENNY_IOS_BUNDLE_ID) {
    merged.APP_ATTEST_APP_ID = `${merged.IMESSAGE_TEAM_ID}.${merged.PENNY_IOS_BUNDLE_ID}`;
  }
  const r = EnvSchema.safeParse(merged);
  if (!r.success) {
    const lines = r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new EnvError(`invalid environment:\n  ${lines.join('\n  ')}`);
  }
  const e = r.data;
  const relayLive =
    e.PENNY_ENV === 'mainnet' && e.DRY_RUN === '0' && Boolean(e.NEAR_RELAYER_PRIVATE_KEY);
  return Object.freeze({ ...e, relayLive });
}
