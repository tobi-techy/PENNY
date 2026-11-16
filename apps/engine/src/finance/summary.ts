import { type CardLine, formatUsd } from '@penny/shared';

/**
 * Finance's week, in one number and two plain sentences (docs/DESIGN.md
 * "Weekly check-in"). Pure functions only: the ledger rows come from the repo,
 * nothing here reads a clock or a database.
 */

export const WEEK_MS = 7 * 24 * 60 * 60_000;
export const DAY_MS = 24 * 60 * 60_000;

export type SpendWindow = { totalMicrosUsd: bigint; count: number };

export type TopRecipient = { recipient: string; microsUsd: bigint };

export type CheckinCard = {
  title: string;
  amount: string;
  lines: CardLine[];
};

/** What Finance can answer on demand ("what did I spend this week?"). */
export type SpendSummary = {
  days: number;
  spent: string;
  payments: number;
  mostTo: string | null;
};

export interface FinancePort {
  summary(userId: string, days: number): Promise<SpendSummary>;
}

/** "Nov 9 – 15" in the user's zone; both ends share a month most weeks. */
export function shortRange(from: Date, to: Date, timeZone: string): string {
  const day = (d: Date) =>
    new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone }).format(d);
  const a = day(from);
  const b = day(to);
  const monthA = a.split(' ')[0];
  const monthB = b.split(' ')[0];
  return monthA === monthB ? `${a} – ${b.split(' ')[1]}` : `${a} – ${b}`;
}

/** How this week compares to the one before, in words, never in judgement. */
export function compareCopy(now: bigint, prior: bigint): string {
  if (prior <= 0n) return "first week I've got numbers for";
  if (now === prior) return 'same as last week';
  if (now < prior) return `${formatUsd(prior - now)} less than last week`;
  return `${formatUsd(now - prior)} more than last week`;
}

/** Who took most of the week, in one row a person can read. */
export function topRecipientCopy(top: TopRecipient | null): string {
  if (!top) return 'nothing yet';
  const name = top.recipient.length > 40 ? `${top.recipient.slice(0, 39)}…` : top.recipient;
  return `${name} · ${formatUsd(top.microsUsd)}`;
}

/**
 * The Sunday card: one number, one comparison, one place the money went.
 * Nothing is sent when the week was empty; silence is better than "$0.00".
 */
export function buildCheckinCard(input: {
  window: SpendWindow;
  prior: bigint;
  top: TopRecipient | null;
  from: Date;
  to: Date;
  timeZone: string;
}): CheckinCard {
  const { window, prior, top } = input;
  const payments = window.count === 1 ? '1 payment' : `${window.count} payments`;
  return {
    title: `This week · ${shortRange(input.from, input.to, input.timeZone)}`,
    amount: formatUsd(window.totalMicrosUsd),
    lines: [
      { label: 'Spent', value: `${formatUsd(window.totalMicrosUsd)} in ${payments}` },
      { label: 'Last week', value: compareCopy(window.totalMicrosUsd, prior) },
      { label: 'Most went to', value: topRecipientCopy(top) },
    ],
  };
}
