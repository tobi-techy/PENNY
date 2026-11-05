/**
 * Live-mode gate (SECURITY.md): a mainnet broadcast requires
 *   PENNY_ENV=mainnet AND DRY_RUN=0 AND a signer key present (config level)
 *   AND the caller passing { dryRun: false, env: 'mainnet' } (call level).
 * Anything else is a dry run. Defaults are dry.
 */
export type PennyEnv = 'dev' | 'mainnet';

export interface ChainMode {
  env: PennyEnv;
  /** Defaults to true. Only an explicit false turns it off. */
  dryRun: boolean;
}

export interface LiveRequest {
  dryRun?: boolean;
  env?: PennyEnv;
}

export const DEFAULT_MODE: ChainMode = Object.freeze({ env: 'dev', dryRun: true });

export function modeFromEnv(env: Record<string, string | undefined> = process.env): ChainMode {
  const e = env.PENNY_ENV === 'mainnet' ? 'mainnet' : 'dev';
  // Only the exact string "0" turns dry-run off. Missing, "", "false", "no" all stay dry.
  const dryRun = env.DRY_RUN !== '0';
  return { env: e, dryRun };
}

export function isLive(
  mode: ChainMode,
  hasSignerKey: boolean,
  req: LiveRequest | undefined,
): boolean {
  return (
    mode.env === 'mainnet' &&
    mode.dryRun === false &&
    hasSignerKey &&
    req !== undefined &&
    req.dryRun === false &&
    req.env === 'mainnet'
  );
}
