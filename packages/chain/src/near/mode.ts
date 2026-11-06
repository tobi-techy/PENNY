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
  /**
   * NEAR network the RPC points at. Testnet broadcasts are allowed when
   * dryRun is off (that is what testnet is for); mainnet broadcasts still
   * require env=mainnet at both config and call level.
   */
  network?: 'mainnet' | 'testnet';
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
  const network =
    env.NEAR_NETWORK === 'testnet' || (env.NEAR_RPC_URL ?? '').includes('testnet')
      ? 'testnet'
      : 'mainnet';
  return { env: e, dryRun, network };
}

export function isLive(
  mode: ChainMode,
  hasSignerKey: boolean,
  req: LiveRequest | undefined,
): boolean {
  if (mode.dryRun !== false || !hasSignerKey || req?.dryRun !== false) return false;
  // Testnet: broadcasting is the point; dryRun=0 + a signer is enough.
  if (mode.network === 'testnet') return true;
  // Mainnet (or unspecified network): both levels must say mainnet.
  return mode.env === 'mainnet' && req.env === 'mainnet';
}
