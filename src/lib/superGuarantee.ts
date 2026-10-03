// Statutory super guarantee (SG) rate for the employee forms.
//
// Mirrors SG_RATE_TABLE in supabase/functions/payroll-create-pay-run/super.ts, which pay runs apply as a floor
// (sources are cited there: SGAA 1992 s 19(2) and, from 1 July 2026, s 17A(2)). The EmployeeSuperDefault test
// keeps the two tables identical.

import { DEFAULT_TIME_ZONE, todayLocal } from '@/lib/localDates';

/** Charge percentage by the first pay date it applies to, newest first. */
export const SG_RATE_TABLE: readonly { from: string; pct: number }[] = [
  { from: '2025-07-01', pct: 12 },
  { from: '2024-07-01', pct: 11.5 },
  { from: '2023-07-01', pct: 11 },
  { from: '2022-07-01', pct: 10.5 },
  { from: '2021-07-01', pct: 10 },
  { from: '2014-07-01', pct: 9.5 },
  { from: '2013-07-01', pct: 9.25 },
];

/** A date as YYYY-MM-DD in Australian (Brisbane) time, so the rate flips on 1 July AEST. */
export function localIsoDate(d: Date = new Date()): string {
  return todayLocal(DEFAULT_TIME_ZONE, d);
}

/** The statutory SG percentage for wages paid on payDate (YYYY-MM-DD). */
export function statutorySuperRatePct(payDate: string): number {
  const row = SG_RATE_TABLE.find((r) => payDate >= r.from);
  if (!row) throw new Error('no super guarantee rate is recorded for pay dates before 1 July 2013');
  return row.pct;
}

/** The SG percentage for wages paid today: the default super rate for a new employee. */
export function currentStatutorySuperRatePct(now: Date = new Date()): number {
  return statutorySuperRatePct(localIsoDate(now));
}
