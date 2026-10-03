// Super guarantee rate for payroll-create-pay-run (pure, no I/O).
//
// The SG percentage is the "charge percentage" in the Superannuation Guarantee (Administration) Act 1992:
//   - s 19(2) table, by financial year, for quarters before 1 July 2026:
//     https://www.legislation.gov.au/C2004A04402/2025-07-01/2025-07-01/text/original/epub/OEBPS/document_1/document_1.html
//   - s 17A(2), "charge percentage means 12", for QE days (paydays) from 1 July 2026:
//     https://www.legislation.gov.au/C2004A04402/2026-07-01/2026-07-01/text/original/epub/OEBPS/document_1/document_1.html
// The rate follows the date wages are paid (the pay date), not the period the work was done ("the 12% rate will need
// to be applied for all salary and wages paid to eligible workers on and after 1 July"):
//   https://www.ato.gov.au/businesses-and-organisations/small-business-newsroom/the-final-sg-rate-increase-is-coming-on-1-july
//
// The SG rate is a floor. An employee or organisation rate above it is honoured; one below it is raised to it.

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

const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** The statutory SG percentage for wages paid on payDate (YYYY-MM-DD). Throws for a malformed or unsupported date. */
export function statutorySuperRatePct(payDate: string): number {
  if (typeof payDate !== 'string' || !ISO_DATE.test(payDate)) {
    throw new Error(`pay_date must be a date in YYYY-MM-DD form, got ${JSON.stringify(payDate)}`);
  }
  const row = SG_RATE_TABLE.find((r) => payDate >= r.from);
  if (!row) throw new Error('no super guarantee rate is recorded for pay dates before 1 July 2013');
  return row.pct;
}

export type SuperRateSource = 'employee' | 'organisation' | 'statutory';

export interface EffectiveSuperRate {
  /** The rate the payslip uses: the configured rate, but never below the statutory rate. */
  pct: number;
  statutoryPct: number;
  /** The employee's rate, else the organisation default; null when neither is set. */
  configuredPct: number | null;
  source: SuperRateSource;
  /** True when a configured rate below the SG rate was raised to it. */
  raisedToStatutory: boolean;
}

function parsePct(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function effectiveSuperRate(input: {
  payDate: string;
  employeePct?: number | string | null;
  organisationPct?: number | string | null;
}): EffectiveSuperRate {
  const statutoryPct = statutorySuperRatePct(input.payDate);
  const employeePct = parsePct(input.employeePct);
  const organisationPct = parsePct(input.organisationPct);
  const configuredPct = employeePct ?? organisationPct;
  if (configuredPct == null) {
    return { pct: statutoryPct, statutoryPct, configuredPct: null, source: 'statutory', raisedToStatutory: false };
  }
  const raisedToStatutory = configuredPct < statutoryPct;
  return {
    pct: raisedToStatutory ? statutoryPct : configuredPct,
    statutoryPct,
    configuredPct,
    source: employeePct != null ? 'employee' : 'organisation',
    raisedToStatutory,
  };
}
