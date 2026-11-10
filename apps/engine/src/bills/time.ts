/** Small timezone helpers (Intl only, no deps). Default zone: Africa/Lagos. */

export const DEFAULT_TIME_ZONE = 'Africa/Lagos';

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Minutes east of UTC for `tz` at instant `at` (e.g. Lagos = 60). */
export function tzOffsetMinutes(tz: string, at: Date): number {
  const name =
    new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' })
      .formatToParts(at)
      .find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const m = name.match(/GMT([+-])(\d{2}):?(\d{2})?/);
  if (!m) return 0;
  const mins = Number(m[2]) * 60 + Number(m[3] ?? 0);
  return m[1] === '-' ? -mins : mins;
}

/** YYYY-MM-DD of `at` in `tz`. */
export function localDate(tz: string, at: Date): string {
  return new Date(at.getTime() + tzOffsetMinutes(tz, at) * 60_000).toISOString().slice(0, 10);
}

/** The instant of `hh:00` local time on `ymd` in `tz`. */
export function localTimeOn(tz: string, ymd: string, hour: number): Date {
  const guess = new Date(`${ymd}T${String(hour).padStart(2, '0')}:00:00Z`);
  return new Date(guess.getTime() - tzOffsetMinutes(tz, guess) * 60_000);
}

/** Add whole days to a YYYY-MM-DD. */
export function addDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  return new Date(d.getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Normalise an ISO date-time with an explicit offset to second precision.
 * Models naturally write `2026-11-14T18:00+01:00` (minutes only), which
 * `z.iso.datetime({ offset: true })` rejects. Returns null for a non-date
 * (31 Feb, +25:00) rather than letting Date silently roll it over.
 */
export function normalizeOffsetDateTime(raw: string): string | null {
  const m =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(
      raw.trim(),
    );
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = m[6] === undefined ? 0 : Number(m[6]);
  const offset = m[7] as string;
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day > daysInMonth) return null;
  if (offset !== 'Z') {
    const off = /^[+-](\d{2}):(\d{2})$/.exec(offset);
    if (!off) return null;
    const oh = Number(off[1]);
    const om = Number(off[2]);
    if (oh > 14 || om > 59 || (oh === 14 && om !== 0)) return null;
  }
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${String(second).padStart(2, '0')}${offset}`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

/** "Sat 8 Nov 2026, 14:05 (Africa/Lagos, UTC+01:00)" for the system prompt. */
export function describeNow(tz: string, at: Date): string {
  const s = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(at);
  const off = tzOffsetMinutes(tz, at);
  const sign = off < 0 ? '-' : '+';
  const abs = Math.abs(off);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${s} (${tz}, UTC${sign}${hh}:${mm})`;
}
