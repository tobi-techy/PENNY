import { compareDecimal, subDecimal } from '@penny/shared';
import { addDays } from '../bills/time.ts';
import type { Cadence } from '../repo/commitments.ts';

const DAY_MS = 86_400_000;

/** Whole days from one YYYY-MM-DD to another (negative when `to` is earlier). */
export function daysBetween(fromYmd: string, toYmd: string): number {
  const from = Date.parse(`${fromYmd}T00:00:00Z`);
  const to = Date.parse(`${toYmd}T00:00:00Z`);
  return Math.round((to - from) / DAY_MS);
}

/** Add calendar months to a YYYY-MM-DD, clamping to the last day of the month. */
export function addMonths(ymd: string, months: number): string {
  const [year = 1970, month = 1, day = 1] = ymd.split('-').map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

/** Recognise a recurring rhythm from the gap between two bills. */
export function detectCadence(gapDays: number): Cadence | null {
  if (gapDays >= 5 && gapDays <= 9) return 'weekly';
  if (gapDays >= 25 && gapDays <= 35) return 'monthly';
  if (gapDays >= 350 && gapDays <= 380) return 'yearly';
  return null;
}

/** The next expected bill date, one rhythm after the last observed bill. */
export function nextExpectedOn(receivedOn: string, cadence: Cadence): string {
  if (cadence === 'weekly') return addDays(receivedOn, 7);
  if (cadence === 'monthly') return addMonths(receivedOn, 1);
  return addMonths(receivedOn, 12);
}

/** "last month" / "last week" / "last year" / "last time". */
export function cadenceWord(cadence: Cadence | null): string {
  if (cadence === 'weekly') return 'last week';
  if (cadence === 'monthly') return 'last month';
  if (cadence === 'yearly') return 'last year';
  return 'last time';
}

export type AmountChange = {
  direction: 'same' | 'up' | 'down' | 'unknown';
  /** Absolute difference, when both amounts and currencies are comparable. */
  delta: string | null;
};

export function amountChange(
  previousAmount: string | null,
  previousCurrency: 'NGN' | 'USD' | null,
  amount: string | null,
  currency: 'NGN' | 'USD' | null,
): AmountChange {
  if (!previousAmount || !amount || !previousCurrency || !currency) {
    return { direction: 'unknown', delta: null };
  }
  if (previousCurrency !== currency) return { direction: 'unknown', delta: null };
  const cmp = compareDecimal(amount, previousAmount);
  if (cmp === 0) return { direction: 'same', delta: null };
  return {
    direction: cmp > 0 ? 'up' : 'down',
    delta: cmp > 0 ? subDecimal(amount, previousAmount) : subDecimal(previousAmount, amount),
  };
}

/** Lowercase, punctuation-free name used when a biller id is not known. */
export function normalizePayee(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * One obligation per biller. When the biller is unknown, the normalized payee
 * and currency keep different currencies' bills apart.
 */
export function commitmentKey(bill: {
  billerId: string | null;
  payeeName: string;
  currency: 'NGN' | 'USD' | null;
}): string {
  if (bill.billerId) return `biller:${bill.billerId}`;
  return `payee:${normalizePayee(bill.payeeName)}:${bill.currency ?? 'x'}`;
}
