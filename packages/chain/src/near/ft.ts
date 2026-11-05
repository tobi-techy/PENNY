import { z } from 'zod';
import type { NearRpc } from './rpc.ts';

/** Native Circle USDC on NEAR mainnet (verified: ft_metadata symbol "USDC", decimals 6; listed by 1Click /v0/tokens). */
export const USDC_CONTRACT = '17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
export const USDC_DECIMALS = 6;
export const USDC_ASSET_ID = `nep141:${USDC_CONTRACT}`;
/** storage_balance_bounds on the USDC contract returned min = max = 0.00125 NEAR (1.25e21 yocto) on 2026-11-05. */
export const USDC_STORAGE_DEPOSIT = 1_250_000_000_000_000_000_000n;

const DECIMAL_RE = /^(0|[1-9]\d*)(\.\d+)?$/;

export class AmountError extends Error {
  override name = 'AmountError';
}

/** "12.34" -> 12340000n for 6 decimals. bigint only; rejects excess precision instead of rounding. */
export function toBaseUnits(decimal: string, decimals: number): bigint {
  if (!DECIMAL_RE.test(decimal)) throw new AmountError(`not a decimal amount: ${decimal}`);
  const [whole = '0', frac = ''] = decimal.split('.');
  if (frac.length > decimals) throw new AmountError(`more than ${decimals} decimals`);
  return (
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0')
  );
}

/** 12340000n, 6 -> "12.34". */
export function fromBaseUnits(amount: bigint, decimals: number): string {
  if (amount < 0n) throw new AmountError('negative amount');
  const base = 10n ** BigInt(decimals);
  const whole = amount / base;
  const frac = (amount % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

const U128Json = z
  .string()
  .regex(/^\d+$/)
  .transform((s) => BigInt(s));

export async function ftBalanceOf(rpc: NearRpc, token: string, accountId: string): Promise<bigint> {
  return U128Json.parse(await rpc.callView(token, 'ft_balance_of', { account_id: accountId }));
}

/** null when not registered. */
export async function storageBalanceOf(
  rpc: NearRpc,
  token: string,
  accountId: string,
): Promise<bigint | null> {
  const r = z
    .object({ total: U128Json })
    .nullable()
    .parse(await rpc.callView(token, 'storage_balance_of', { account_id: accountId }));
  return r ? r.total : null;
}

export const FtMetadata = z.object({
  spec: z.string(),
  name: z.string(),
  symbol: z.string(),
  decimals: z.number().int().min(0).max(38),
});
export async function ftMetadata(rpc: NearRpc, token: string): Promise<z.infer<typeof FtMetadata>> {
  return FtMetadata.parse(await rpc.callView(token, 'ft_metadata'));
}
