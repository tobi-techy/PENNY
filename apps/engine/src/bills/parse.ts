import { createHash } from 'node:crypto';
import { type Biller, matchBiller, splitSender } from './billers.ts';

/**
 * Deterministic bill parsing from Gmail metadata (subject, sender, snippet,
 * date). No model involved: amounts and due dates are taken from the email text
 * or left null. Anything ambiguous (e.g. 03/04/2026) is left null rather than
 * guessed.
 */

export type ParsedBill = {
  sourceKey: string;
  biller: Biller | undefined;
  payeeName: string;
  subject: string;
  amount: string | null;
  currency: 'NGN' | 'USD' | null;
  dueOn: string | null; // YYYY-MM-DD
  receivedAt: Date | null;
  snippet: string;
};

// Case-sensitive on purpose: a bare "N" only counts as naira when it is a
// capital directly before digits ("N18,400"), so "in2024" never reads as money.
const AMOUNT_RE =
  /(₦|NGN\s?|USD\s?|\bN(?=\d)|\$)\s?(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/;

/** Receipts and payment confirmations are not bills to pay. */
const RECEIPT_RE =
  /\b(receipt|payment (?:successful|received|confirmed|confirmation)|thanks? (?:you )?for your payment|successfully paid|has been paid)\b/i;

export function isReceipt(subject: string): boolean {
  return RECEIPT_RE.test(subject);
}

export function parseAmount(text: string): { amount: string; currency: 'NGN' | 'USD' } | null {
  const m = text.match(AMOUNT_RE);
  if (!m?.[1] || !m[2]) return null;
  const sym = m[1].trim().toUpperCase();
  const currency = sym === '$' || sym === 'USD' ? 'USD' : 'NGN';
  let amount = m[2].replace(/,/g, '');
  if (amount.includes('.')) amount = amount.replace(/\.?0+$/, '');
  if (!/^\d+(\.\d{1,2})?$/.test(amount) || /^0+(\.0+)?$/.test(amount)) return null;
  return { amount: amount.replace(/^0+(?=\d)/, ''), currency };
}

const MONTHS = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
] as const;
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function utcDate(y: number, m: number, d: number): Date | null {
  const dt = new Date(Date.UTC(y, m, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m && dt.getUTCDate() === d ? dt : null;
}

/** A day+month with no year: the next occurrence on or after `ref`'s date (within a year). */
function nextDayMonth(ref: Date, month: number, day: number): Date | null {
  const y = ref.getUTCFullYear();
  const refDay = Date.UTC(y, ref.getUTCMonth(), ref.getUTCDate());
  const same = utcDate(y, month, day);
  if (same && same.getTime() >= refDay - 7 * 86_400_000) return same; // allow "due" just passed
  return utcDate(y + 1, month, day);
}

function monthIndex(s: string): number {
  return MONTHS.indexOf(s.slice(0, 3).toLowerCase() as (typeof MONTHS)[number]);
}

/**
 * Due date from text like "due Friday", "due by 14 Nov", "due on November 14, 2026",
 * "due date: 2026-11-14", "due tomorrow", "expires 14/11/2026" (only when the day
 * is > 12, so the order is unambiguous). `ref` is when the email arrived.
 */
export function parseDueDate(text: string, ref: Date): string | null {
  const t = text.toLowerCase();
  const cue = t.match(
    /(?:due|pay(?:ment)? by|expires?|expiry|expiring|renews?|before|deadline)(?:\s+date)?\s*(?:is|on|by|:)?\s*(?:on|by)?\s*([^.;\n]{0,40})/,
  );
  if (!cue?.[1]) return null;
  const s = cue[1].trim();

  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const d = utcDate(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return d ? ymd(d) : null;
  }
  m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]{3,9})\.?(?:,?\s+(\d{4}))?/);
  if (m && monthIndex(m[2] ?? '') >= 0) {
    const mi = monthIndex(m[2] ?? '');
    const d = m[3] ? utcDate(Number(m[3]), mi, Number(m[1])) : nextDayMonth(ref, mi, Number(m[1]));
    return d ? ymd(d) : null;
  }
  m = s.match(/^([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?/);
  if (m && monthIndex(m[1] ?? '') >= 0) {
    const mi = monthIndex(m[1] ?? '');
    const d = m[3] ? utcDate(Number(m[3]), mi, Number(m[2])) : nextDayMonth(ref, mi, Number(m[2]));
    return d ? ymd(d) : null;
  }
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a > 12 && b <= 12) {
      const d = utcDate(Number(m[3]), b - 1, a); // day/month (Nigeria)
      return d ? ymd(d) : null;
    }
    if (b > 12 && a <= 12) {
      const d = utcDate(Number(m[3]), a - 1, b); // month/day
      return d ? ymd(d) : null;
    }
    return null; // ambiguous
  }
  const base = Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate());
  if (/^today\b/.test(s)) return ymd(new Date(base));
  if (/^tomorrow\b/.test(s)) return ymd(new Date(base + 86_400_000));
  m = s.match(/^(?:this\s+|next\s+)?(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/);
  if (m) {
    const want = DAYS.indexOf(m[1] as (typeof DAYS)[number]);
    let delta = (want - ref.getUTCDay() + 7) % 7;
    if (delta === 0) delta = 7;
    return ymd(new Date(base + delta * 86_400_000));
  }
  return null;
}

function parseDate(v: unknown): Date | null {
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'number' ? v : /^\d{10,13}$/.test(String(v)) ? Number(v) : Number.NaN;
  const d = Number.isFinite(n) ? new Date(n < 1e12 ? n * 1000 : n) : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Parse a GMAIL_FETCH_EMAILS result into bills. `now` is the fallback received time. */
export function parseBills(raw: unknown, now: Date): ParsedBill[] {
  const data = (raw as { data?: unknown })?.data ?? raw;
  const messages = (data as { messages?: unknown })?.messages;
  if (!Array.isArray(messages)) return [];
  const out: ParsedBill[] = [];
  for (const m of messages.slice(0, 25)) {
    if (!m || typeof m !== 'object') continue;
    const r = m as Record<string, unknown>;
    const subject = String(r.subject ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160);
    if (!subject || isReceipt(subject)) continue;
    const sender = String(r.sender ?? r.from ?? '').slice(0, 160);
    const snippet = String(r.snippet ?? r.preview ?? r.messageText ?? '')
      .replace(/\s+/g, ' ')
      .slice(0, 400);
    const receivedAt = parseDate(r.messageTimestamp ?? r.internalDate ?? r.date);
    const text = `${subject}. ${snippet}`;
    const money = parseAmount(text);
    const biller = matchBiller(sender, subject);
    const id = String(r.messageId ?? r.id ?? '').slice(0, 128);
    const sourceKey = id
      ? `gmail:${id}`
      : `hash:${createHash('sha256')
          .update(`${sender}|${subject}|${receivedAt?.toISOString() ?? ''}`)
          .digest('hex')
          .slice(0, 32)}`;
    out.push({
      sourceKey,
      biller,
      payeeName: biller?.name ?? splitSender(sender).name ?? 'Unknown',
      subject,
      amount: money?.amount ?? null,
      currency: money?.currency ?? biller?.currency ?? null,
      dueOn: parseDueDate(text, receivedAt ?? now),
      receivedAt,
      snippet,
    });
  }
  return out;
}

const SYM = { NGN: '₦', USD: '$' } as const;

/** "₦18,400" / "$12.50" / "amount not shown". */
export function formatMoney(amount: string | null, currency: 'NGN' | 'USD' | null): string {
  if (!amount) return 'amount not shown';
  const [whole, frac] = amount.split('.');
  const grouped = (whole ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const value = frac ? `${grouped}.${frac.padEnd(2, '0')}` : grouped;
  return `${currency ? SYM[currency] : ''}${value}`;
}

/** "fri 14 nov" for a YYYY-MM-DD. */
export function formatDay(dueOn: string): string {
  const d = new Date(`${dueOn}T00:00:00Z`);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}
