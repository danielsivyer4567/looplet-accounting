// Calendar dates in the organisation's Australian time zone.
//
// `new Date().toISOString().slice(0, 10)` is the UTC date. From 10 am AEST (11 am
// AEDT) the UTC date is still "yesterday", so an invoice issued or a timesheet
// entered in the evening defaulted to the day before, and on the evening of
// 30 June the financial year had not rolled over yet. Everything here works on
// `YYYY-MM-DD` strings and takes an IANA time zone, defaulting to
// Australia/Brisbane (no daylight saving) when the organisation's state is not
// recorded. The zone mapping mirrors public.au_state_timezone in the BAS
// migration 20261003150000, except the client default is Brisbane as agreed.
//
// Keep this dependency-free and presentation-neutral (see money.ts, formatting.ts).

export const DEFAULT_TIME_ZONE = 'Australia/Brisbane';

/** business_profile.state_code -> IANA zone (same table as public.au_state_timezone). */
export const AU_STATE_TIME_ZONES: Readonly<Record<string, string>> = {
  QLD: 'Australia/Brisbane',
  NSW: 'Australia/Sydney',
  ACT: 'Australia/Sydney',
  VIC: 'Australia/Melbourne',
  TAS: 'Australia/Hobart',
  SA: 'Australia/Adelaide',
  NT: 'Australia/Darwin',
  WA: 'Australia/Perth',
};

/** The time zone to use for an organisation: its state's zone when known, else Brisbane. */
export function orgTimeZone(org: { state_code?: string | null } | null | undefined): string {
  const code = org?.state_code?.trim().toUpperCase() ?? '';
  return AU_STATE_TIME_ZONES[code] ?? DEFAULT_TIME_ZONE;
}

export interface LocalDateParts {
  year: number;
  /** 1 = January … 12 = December. */
  month: number;
  day: number;
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let fmt = partsFormatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-AU', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
    });
    partsFormatters.set(timeZone, fmt);
  }
  return fmt;
}

/** The wall-clock calendar date of `now` in `timeZone`. */
export function localDateParts(now: Date = new Date(), timeZone = DEFAULT_TIME_ZONE): LocalDateParts {
  const parts: Record<string, string> = {};
  for (const p of partsFormatter(timeZone).formatToParts(now)) parts[p.type] = p.value;
  return {
    year: Number(parts['year']),
    month: Number(parts['month']),
    day: Number(parts['day']),
    weekday: Math.max(0, WEEKDAYS.indexOf((parts['weekday'] ?? '').slice(0, 3))),
  };
}

/** `YYYY-MM-DD` from numeric parts; month is 1-based. */
export function isoDate(year: number, month: number, day: number): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** Today's date (`YYYY-MM-DD`) in the organisation's time zone. */
export function todayLocal(timeZone = DEFAULT_TIME_ZONE, now: Date = new Date()): string {
  const { year, month, day } = localDateParts(now, timeZone);
  return isoDate(year, month, day);
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/;

/** True when `value` starts with a `YYYY-MM-DD` date (a date input's value, a date column). */
export function isIsoDate(value: string | null | undefined): value is string {
  return typeof value === 'string' && ISO_DATE.test(value);
}

/** Parse the leading `YYYY-MM-DD` of a date string; throws on anything else. */
export function parseIsoDate(date: string): { year: number; month: number; day: number } {
  const m = ISO_DATE.exec(date);
  if (!m) throw new Error(`expected a YYYY-MM-DD date, got "${date}"`);
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

// Calendar arithmetic goes through Date.UTC so the host zone (and its daylight
// saving transitions) can never shift the result by a day.
function utcOf(date: string): Date {
  const { year, month, day } = parseIsoDate(date);
  return new Date(Date.UTC(year, month - 1, day));
}

function fromUtc(d: Date): string {
  return isoDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** `date` moved by `days` (negative for earlier). */
export function addDays(date: string, days: number): string {
  const d = utcOf(date);
  d.setUTCDate(d.getUTCDate() + days);
  return fromUtc(d);
}

/** `date` moved by whole months; the day clamps to the target month's length (31 Jan + 1 -> 28/29 Feb). */
export function addMonths(date: string, months: number): string {
  const { year, month, day } = parseIsoDate(date);
  const first = new Date(Date.UTC(year, month - 1 + months, 1));
  const last = daysInMonth(first.getUTCFullYear(), first.getUTCMonth() + 1);
  return isoDate(first.getUTCFullYear(), first.getUTCMonth() + 1, Math.min(day, last));
}

/** Number of days in a month (1-based). */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 0 = Sunday … 6 = Saturday for a `YYYY-MM-DD` date. */
export function weekdayOf(date: string): number {
  return utcOf(date).getUTCDay();
}

/** First day of the month containing `date`. */
export function startOfMonth(date: string): string {
  const { year, month } = parseIsoDate(date);
  return isoDate(year, month, 1);
}

/** Last day of the month containing `date`. */
export function endOfMonth(date: string): string {
  const { year, month } = parseIsoDate(date);
  return isoDate(year, month, daysInMonth(year, month));
}

/** First day of the calendar quarter (Jan, Apr, Jul, Oct) containing `date`. */
export function startOfCalendarQuarter(date: string): string {
  const { year, month } = parseIsoDate(date);
  return isoDate(year, Math.floor((month - 1) / 3) * 3 + 1, 1);
}

/** First day of the calendar year containing `date`. */
export function startOfCalendarYear(date: string): string {
  return isoDate(parseIsoDate(date).year, 1, 1);
}

/**
 * The Australian income year runs 1 July to 30 June and is named by its start year:
 * 2026-07-01 … 2027-06-30 is FY 2026 (shown as FY26–27).
 * https://www.ato.gov.au/individuals-and-families/coming-to-australia-or-going-overseas/coming-to-australia/tax-in-australia-what-you-need-to-know
 */
export function financialYearStartYear(date: string): number {
  const { year, month } = parseIsoDate(date);
  return month >= 7 ? year : year - 1;
}

/** 1 July opening the financial year that contains `date`. */
export function startOfFinancialYear(date: string): string {
  return `${financialYearStartYear(date)}-07-01`;
}

/** 30 June closing the financial year that contains `date`. */
export function endOfFinancialYear(date: string): string {
  return `${financialYearStartYear(date) + 1}-06-30`;
}

/** The FY quarter containing `date`: Q1 Jul–Sep, Q2 Oct–Dec, Q3 Jan–Mar, Q4 Apr–Jun. */
export function financialYearQuarter(date: string): { fyStartYear: number; quarter: number } {
  const { month } = parseIsoDate(date);
  const fyMonth0 = (month - 1 + 6) % 12; // 0 = Jul … 11 = Jun
  return { fyStartYear: financialYearStartYear(date), quarter: Math.floor(fyMonth0 / 3) + 1 };
}

/**
 * Display a `YYYY-MM-DD` date in en-AU without touching the host time zone:
 * "01 Jul 2026" by default. Unparseable or empty input renders as an em dash.
 */
export function formatDateAu(
  date: string | null | undefined,
  options: Intl.DateTimeFormatOptions = { day: '2-digit', month: 'short', year: 'numeric' },
): string {
  if (!date || !ISO_DATE.test(date)) return '—';
  return new Intl.DateTimeFormat('en-AU', { ...options, timeZone: 'UTC' }).format(utcOf(date));
}

/** Display a timestamp as a date in the organisation's time zone, e.g. "01 Jul 2026". */
export function formatTimestampAu(
  timestamp: string | Date | null | undefined,
  timeZone = DEFAULT_TIME_ZONE,
  options: Intl.DateTimeFormatOptions = { day: '2-digit', month: 'short', year: 'numeric' },
): string {
  if (!timestamp) return '—';
  const d = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('en-AU', { ...options, timeZone }).format(d);
}
