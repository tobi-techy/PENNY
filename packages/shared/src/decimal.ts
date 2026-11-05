/**
 * Money math. Decimal strings in, bigint base units inside. No floats, ever.
 * Decimal = ^\d+(\.\d{1,6})?$  (ARCHITECTURE.md)
 */

export const DECIMAL_RE = /^\d+(\.\d{1,6})?$/;
export const MAX_DECIMAL_PLACES = 6;

export const ASSET_DECIMALS = {
  USDC: 6,
  NEAR: 24,
} as const;
export type KnownAsset = keyof typeof ASSET_DECIMALS;

export class DecimalError extends Error {
  override name = 'DecimalError';
}

export function isDecimal(s: string): boolean {
  return DECIMAL_RE.test(s);
}

/** "12.5" with decimals=6 -> 12500000n */
export function toBaseUnits(amount: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new DecimalError('decimals out of range');
  }
  if (!DECIMAL_RE.test(amount)) throw new DecimalError(`not a valid decimal: "${amount}"`);
  const [whole = '0', frac = ''] = amount.split('.');
  if (frac.length > decimals) {
    throw new DecimalError(
      `more fractional digits (${frac.length}) than asset allows (${decimals})`,
    );
  }
  return BigInt(whole + frac.padEnd(decimals, '0'));
}

/** 12500000n with decimals=6 -> "12.5". Full precision, trailing zeros trimmed. */
export function fromBaseUnits(units: bigint, decimals: number): string {
  if (units < 0n) throw new DecimalError('negative base units');
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new DecimalError('decimals out of range');
  }
  if (decimals === 0) return units.toString();
  const s = units.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, -decimals);
  const frac = s.slice(-decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

/** Decimal -> micro units (6 dp), the common unit for USD comparisons. */
export function toMicros(amount: string): bigint {
  return toBaseUnits(amount, MAX_DECIMAL_PLACES);
}

export function fromMicros(micros: bigint): string {
  return fromBaseUnits(micros, MAX_DECIMAL_PLACES);
}

export function compareDecimal(a: string, b: string): -1 | 0 | 1 {
  const x = toMicros(a);
  const y = toMicros(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function addDecimal(a: string, b: string): string {
  return fromMicros(toMicros(a) + toMicros(b));
}

export function subDecimal(a: string, b: string): string {
  const r = toMicros(a) - toMicros(b);
  if (r < 0n) throw new DecimalError('result would be negative');
  return fromMicros(r);
}

/** "$50.00". Rounds half-up to cents for display only. */
export function formatUsd(amount: string | bigint): string {
  const micros = typeof amount === 'bigint' ? amount : toMicros(amount);
  const cents = (micros + 5_000n) / 10_000n;
  const whole = cents / 100n;
  const c = (cents % 100n).toString().padStart(2, '0');
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `$${grouped}.${c}`;
}
