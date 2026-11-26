import { formatDay, formatMoney } from '../bills/parse.ts';
import type { Cadence, CommitmentRow } from '../repo/commitments.ts';
import { amountChange, cadenceWord } from './cadence.ts';

/**
 * The comparison line for a repeat bill, in the user's own rhythm. Falls back
 * to "last time" when the gap was too irregular for Penny to name a cadence.
 */
export function repeatLine(
  previousAmount: string | null,
  previousCurrency: 'NGN' | 'USD' | null,
  amount: string | null,
  currency: 'NGN' | 'USD' | null,
  cadence: Cadence | null,
): string {
  const change = amountChange(previousAmount, previousCurrency, amount, currency);
  const word = cadenceWord(cadence);
  if (change.direction === 'same') return `same as ${word}.`;
  if (change.delta && currency) {
    const direction = change.direction === 'up' ? 'more' : 'less';
    return `that's ${formatMoney(change.delta, currency)} ${direction} than ${word}.`;
  }
  return '';
}

/** Promise only the watching that actually exists. */
export function watchSuffix(hasReminder: boolean): string {
  return hasReminder
    ? "i'll remind you, and watch for the next one."
    : "i'll watch for the next one.";
}

/** The receipt closes the loop by naming what happens next. */
export function receiptSuffix(nextExpectedOn: string | null): string {
  return nextExpectedOn ? `next one expected around ${formatDay(nextExpectedOn)}.` : '';
}

/** One unprompted check when the next bill has not arrived. */
export function expectedText(payee: string, expectedOn: string): string {
  return `i expected your ${payee} bill around ${formatDay(expectedOn)}. nothing in your inbox yet. if it's gone for good, say stop watching ${payee}.`;
}

/** A single, quieter nudge a few days later. Never repeated. */
export function missingText(payee: string): string {
  return `still no ${payee} bill. i'll leave it here in case it's late.`;
}

function paidLabel(count: number): string {
  if (count <= 0) return '';
  return count === 1 ? 'paid once.' : `paid ${count} times.`;
}

function amountLabel(row: CommitmentRow): string {
  if (!row.lastAmount) return 'amount varies';
  return formatMoney(row.lastAmount, row.currency);
}

function cadenceLabel(row: CommitmentRow): string {
  return row.cadence ? row.cadence : 'irregular';
}

/**
 * What Penny is watching, in one message the user can act on. Active first,
 * then paused ones, because pausing is reversible and worth surfacing.
 */
export function commitmentsText(
  active: readonly CommitmentRow[],
  paused: readonly CommitmentRow[],
  today?: string,
): string {
  if (!active.length && !paused.length) {
    return "i'm not watching any bills yet. connect gmail and ask me to find bills.";
  }
  const lines: string[] = [];
  if (active.length) {
    lines.push(
      active.length === 1 ? "i'm watching 1 bill:" : `i'm watching ${active.length} bills:`,
    );
    for (const row of active) {
      const next = row.nextExpectedOn
        ? today && row.nextExpectedOn < today
          ? `, expected ${formatDay(row.nextExpectedOn)}, not seen`
          : `, next around ${formatDay(row.nextExpectedOn)}`
        : '';
      const paid = paidLabel(row.paidCount);
      lines.push(
        `• ${row.payeeName}: ${amountLabel(row)} ${cadenceLabel(row)}${next}.${paid ? ` ${paid}` : ''}`,
      );
    }
  } else {
    lines.push("i'm not watching any bills right now.");
  }
  if (paused.length) {
    lines.push(`paused: ${paused.map((r) => r.payeeName).join(', ')}.`);
  }
  lines.push('say stop watching <name> to pause one.');
  return lines.join('\n');
}

export function pausedText(payee: string): string {
  return `ok, i'll stop watching ${payee}. say start watching ${payee} when you want me back on it.`;
}

export function resumedText(payee: string): string {
  return `ok, watching ${payee} again.`;
}
