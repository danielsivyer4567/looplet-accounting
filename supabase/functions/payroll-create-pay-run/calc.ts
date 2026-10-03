// Pure wage arithmetic for payroll-create-pay-run (no I/O).
//
// Wages are paid from the employee's BASE hourly rate. wage_components.loaded_hourly_rate_cents is the employer's
// cost rate (base plus super, WorkCover and leave accrual) used for job costing; paying it as wages overpays every
// employee by those on-costs.

export type EntryType = 'ordinary' | 'overtime' | 'annual_leave' | 'sick_leave' | 'public_holiday';

export interface TimesheetHours {
  hours: number | string | null;
  entry_type: string | null;
}

export interface HoursByKind {
  ordinary: number;
  overtime: number;
  leave: number;
}

export interface GrossPay {
  ordinaryCents: number;
  overtimeCents: number;
  leaveCents: number;
  totalCents: number;
  /** Ordinary time earnings: ordinary plus leave, excluding overtime (the super guarantee base). */
  ordinaryTimeEarningsCents: number;
}

/** Default overtime loading until award-specific penalty rates are modelled. */
export const OVERTIME_MULTIPLIER = 1.5;

/** The base hourly rate in cents from wage_components.base_hourly_rate (dollars). Throws when it is missing. */
export function baseHourlyRateCents(wage: { base_hourly_rate?: number | string | null } | null | undefined): number {
  const dollars = Number(wage?.base_hourly_rate);
  if (wage?.base_hourly_rate == null || wage.base_hourly_rate === '' || !Number.isFinite(dollars) || dollars <= 0) {
    throw new Error('employee has no base hourly rate; set it on the employee before running payroll');
  }
  return Math.round(dollars * 100);
}

export function sumHours(rows: TimesheetHours[]): HoursByKind {
  const out: HoursByKind = { ordinary: 0, overtime: 0, leave: 0 };
  for (const row of rows) {
    const hours = Number(row.hours);
    if (!Number.isFinite(hours)) continue;
    const type = (row.entry_type ?? 'ordinary') as EntryType;
    if (type === 'ordinary' || type === 'public_holiday') out.ordinary += hours;
    else if (type === 'overtime') out.overtime += hours;
    else if (type === 'annual_leave' || type === 'sick_leave') out.leave += hours;
  }
  // Timesheets record hours to at most 2 decimal places; drop binary floating-point noise from the sums.
  const tidy = (h: number) => Math.round(h * 10_000) / 10_000;
  return { ordinary: tidy(out.ordinary), overtime: tidy(out.overtime), leave: tidy(out.leave) };
}

export function grossPay(hours: HoursByKind, baseRateCents: number): GrossPay {
  const ordinaryCents = Math.round(hours.ordinary * baseRateCents);
  const overtimeCents = Math.round(hours.overtime * baseRateCents * OVERTIME_MULTIPLIER);
  const leaveCents = Math.round(hours.leave * baseRateCents);
  return {
    ordinaryCents,
    overtimeCents,
    leaveCents,
    totalCents: ordinaryCents + overtimeCents + leaveCents,
    ordinaryTimeEarningsCents: ordinaryCents + leaveCents,
  };
}
