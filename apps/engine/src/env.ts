import { z } from 'zod';

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
  DATABASE_URL: optionalStr,

  SPECTRUM_PROJECT_ID: optionalStr,
  SPECTRUM_PROJECT_SECRET: optionalStr,
  SPECTRUM_WEBHOOK_SECRET: optionalStr,
  IMESSAGE_APP_NAME: z.string().default('Penny'),
  IMESSAGE_EXTENSION_BUNDLE_ID: z.string().default('money.penny.host.messages'),
  IMESSAGE_TEAM_ID: optionalStr,

  NEARAI_BASE_URL: z.url().default('https://cloud-api.near.ai/v1'),
  NEARAI_API_KEY: optionalStr,
  NEARAI_MODEL: z.string().default('z-ai/glm-5.3-flash'),
  NEARAI_ROUTER_MODEL: z.string().default('z-ai/glm-5.3-flash'),
  NEARAI_EMBEDDING_MODEL: z.string().default('Qwen/Qwen3-Embedding-0.6B'),

  COMPOSIO_API_KEY: optionalStr,

  NEAR_NETWORK: z.enum(['mainnet', 'testnet']).default('testnet'),
  NEAR_APP_ACCOUNT_ID: z.string().default('penny.near'),
  NEAR_RELAYER_ACCOUNT_ID: optionalStr,
  NEAR_RELAYER_PRIVATE_KEY: optionalStr,
  NEAR_RPC_URL: optionalStr,
  NEAR_RELAYER_PUBLIC_KEY: optionalStr,
  NEAR_APP_PRIVATE_KEY: optionalStr,
  NEAR_APP_PUBLIC_KEY: optionalStr,
  ONECLICK_API_KEY: optionalStr,
  GLIDER_API_KEY: optionalStr,
  /** Set to 1 only after the testnet end-to-end runbook passes. Gates mainnet boot. */
  PENNY_TESTNET_E2E_OK: flag.default('0'),
  /** Hard per-tx ceiling applied on mainnet regardless of user policy. */
  PENNY_MAINNET_MAX_PER_TX_USD: z
    .string()
    .regex(/^\d+(\.\d{1,6})?$/)
    .default('25'),

  LANGFUSE_PUBLIC_KEY: optionalStr,
  LANGFUSE_SECRET_KEY: optionalStr,
  LANGFUSE_BASE_URL: z.url().default('https://cloud.langfuse.com'),

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
export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const r = EnvSchema.safeParse(source);
  if (!r.success) {
    const lines = r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new EnvError(`invalid environment:\n  ${lines.join('\n  ')}`);
  }
  const e = r.data;
  const relayLive =
    e.PENNY_ENV === 'mainnet' && e.DRY_RUN === '0' && Boolean(e.NEAR_RELAYER_PRIVATE_KEY);
  return Object.freeze({ ...e, relayLive });
}
