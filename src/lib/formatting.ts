// Small shared display formatters (parallel to money.ts). Keep these dependency-free
// and presentation-only.

import { DEFAULT_TIME_ZONE, financialYearStartYear, todayLocal } from '@/lib/localDates';

/** Capitalise the first letter: "discretionary" -> "Discretionary"; null/"" -> "". */
export function titleCase(s: string | null | undefined): string {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** A date(-time) string -> "30 Jun 2024" (en-AU); null -> em dash. */
export function formatDay(d: string | null | undefined): string {
  if (!d) return '—';
  const dt = new Date(d);
  // A non-empty but unparseable value ('0000-00-00', a malformed timestamp) is
  // truthy, so fall back to the em dash rather than render literal "Invalid Date".
  if (Number.isNaN(dt.getTime())) return '—';
  return dt.toLocaleDateString('en-AU', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

/**
 * The current AU income year as its start year (Jul-Dec => this year; Jan-Jun => prior),
 * judged on today's date in the organisation's time zone (lib/localDates.ts).
 */
export function currentFyStartYear(timeZone: string = DEFAULT_TIME_ZONE): number {
  return financialYearStartYear(todayLocal(timeZone));
}

/** Short label for the current AU financial year window, e.g. "FY26–27 (from 1 Jul 2026)". */
export function currentFyLabel(timeZone: string = DEFAULT_TIME_ZONE): string {
  const start = currentFyStartYear(timeZone);
  const endShort = String((start + 1) % 100).padStart(2, '0');
  return `FY${String(start % 100).padStart(2, '0')}–${endShort} (from 1 Jul ${start})`;
}
