// div7a-agreement/agreement.ts — pure doc-builder for the Division 7A complying-loan
// agreement + minimum-repayment-schedule PDF (SC-5.F.01). Split from index.ts so it
// carries NO side effects (index.ts runs Deno.serve at load): the test imports this and
// the pure builder without booting an HTTP listener, and index.ts imports it for the
// handler. Render text is WinAnsi-safe ASCII (hyphens, no em-dashes) per the shared
// renderer's StandardFonts.Helvetica constraint (_shared/pdf/worksheet.ts).

import { type WorksheetDoc } from "../_shared/pdf/worksheet.ts";

export interface LoanRow {
  lender_company_name: string;
  lender_company_abn: string | null;
  borrower_name: string;
  loan_year: number;
  principal_cents: number;
  term_years: number;
  benchmark_rate_basis_points: number | null;
  has_complying_agreement: boolean | null;
}

/** One row of the s109E minimum-repayment schedule (from div7a_min_repayment). */
export interface ScheduleLine {
  income_year: number;
  period_label?: string;
  opening_balance_cents: number;
  rate_basis_points?: number;
  min_repayment_cents?: number;
  interest_cents?: number;
  principal_cents?: number;
  closing_balance_cents?: number;
  rate_missing?: boolean;
}

/** Cents (any) -> "$1,234.00". */
export function money(cents: unknown): string {
  const n = Number(cents ?? 0);
  return `$${(n / 100).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Basis points (875) -> "8.75%"; null -> "n/a". */
export function ratePct(bps: number | null | undefined): string {
  if (bps === null || bps === undefined) return "n/a";
  return `${(bps / 100).toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
}

/**
 * Build the complying-loan agreement document: the parties + complying terms, then the
 * s109E minimum-yearly-repayment schedule (one row per income year). A 7-year loan is
 * unsecured; a 25-year loan must be secured by a registered mortgage over real property
 * (s109N) — stated in the terms so the document reads as a complying agreement.
 */
export function toAgreementDoc(loan: LoanRow, schedule: ScheduleLine[]): WorksheetDoc {
  const secured = loan.term_years === 25;
  const security = secured
    ? "Secured by a registered mortgage over real property (required for a 25-year term, s109N)."
    : "Unsecured (7-year maximum term, s109N).";
  // The loan is entered into in the year it was made; repayments run from the next year.
  const madeFy = `FY${loan.loan_year}-${loan.loan_year + 1}`;
  // If a complying agreement is already on record, this is a re-print of the existing terms;
  // otherwise it is a draft for the parties to execute. (has_complying_agreement, SC-5.E.01.)
  const onRecord = loan.has_complying_agreement === true;
  const status = onRecord ? "agreement on record" : "DRAFT for execution";

  const sections: WorksheetDoc["sections"] = [
    {
      heading: "Parties",
      rows: [
        {
          label: "Lender (private company)",
          value: loan.lender_company_abn
            ? `${loan.lender_company_name} (ABN ${loan.lender_company_abn})`
            : loan.lender_company_name,
        },
        { label: "Borrower (shareholder or associate)", value: loan.borrower_name },
      ],
    },
    {
      heading: "Complying loan terms (Division 7A, s109N)",
      caption: "Minimum interest rate is the ATO benchmark rate; repaid over the maximum term.",
      rows: [
        { label: "Amount of loan (principal)", value: money(loan.principal_cents) },
        { label: "Income year loan made", value: madeFy },
        { label: "Maximum term", value: `${loan.term_years} years` },
        { label: "Benchmark interest rate (year made)", value: ratePct(loan.benchmark_rate_basis_points) },
        { label: "Security", value: security },
      ],
    },
  ];

  // The minimum-yearly-repayment schedule, one section row per income year.
  // "FY2024-2025: $19,207.24 (int $8,000.00 / prin $11,207.24)"; a rate-missing year shows
  // "rate not set" rather than blank numbers.
  const scheduleRows = schedule.map((s) => {
    const label = s.period_label ?? `FY${s.income_year}-${s.income_year + 1}`;
    return s.rate_missing
      ? { label, value: "rate not set" }
      : {
        label,
        value:
          `${money(s.min_repayment_cents)} ` +
          `(int ${money(s.interest_cents)} / prin ${money(s.principal_cents)})`,
      };
  });

  sections.push({
    heading: "Minimum yearly repayment schedule (s109E)",
    caption: "Minimum repayment, and its interest / principal split, for each income year.",
    rows: scheduleRows.length > 0
      ? scheduleRows
      : [{ label: "No schedule", value: "no repayment years (check the loan + benchmark rates)" }],
  });

  return {
    title: "Division 7A Complying Loan Agreement",
    subtitle:
      `${loan.lender_company_name} to ${loan.borrower_name} - ` +
      `${money(loan.principal_cents)} over ${loan.term_years} years - ${status}`,
    sections,
    footer:
      "Draft complying loan agreement generated by Looplet Accounting under ITAA 1936 Division 7A. " +
      "The agreement must be in place, and the minimum yearly repayment made, before the lender " +
      "company's lodgement day for each year to avoid a deemed dividend. Have the parties review " +
      "and sign; verify the security position. This document does not execute or lodge anything.",
  };
}
