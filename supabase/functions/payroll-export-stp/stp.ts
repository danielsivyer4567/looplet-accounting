// Pure STP Phase 2 event builder (extracted from payroll-export-stp's handler so it
// is unit-testable — SC-3.L.02; mirrors _shared/pdf/worksheet.ts). No I/O.
//
// TERMINATION EVENT: when the run carries termination context (run.metadata.termination,
// written by the SC-3.L.03 wizard), the pay event gains a `termination` block (cessation
// date + STP cessation type code) and the terminated employee gains an `etp` block
// (ETP code + taxable/tax-free/withheld). Figures come from the SC-3.L.01 calc.
//
// Codes are simplified to the common life-benefit cases (a human/tax agent confirms):
//   Cessation type (STP Ph2): V voluntary, I invalidity/ill-health, D deceased,
//     R redundancy/early-retirement, F dismissal, C contract cessation, T transfer.
//   ETP code: R (EXCLUDED — genuine redundancy / invalidity / early retirement) vs
//     O (OTHER / non-excluded, e.g. golden handshake). Multi-payment S/P codes and
//     death-benefit ETPs are not modelled.

export interface StpEmployee {
  id: string;
  full_name: string;
  email: string | null;
  wage_components: Record<string, unknown> | null;
}

export interface StpSlip {
  hours_ordinary: number | string;
  hours_overtime: number | string;
  hours_leave: number | string;
  gross_ordinary_cents: number | string;
  gross_overtime_cents: number | string;
  gross_leave_cents: number | string;
  gross_total_cents: number | string;
  payg_tax_cents: number | string;
  super_guarantee_cents: number | string;
  super_rate_pct: number | string;
  net_pay_cents: number | string;
  ytd_gross_cents: number | string;
  ytd_tax_cents: number | string;
  ytd_super_cents: number | string;
  employee: StpEmployee;
}

export interface StpRun {
  organization_id: string;
  period_start: string;
  period_end: string;
  pay_date: string;
  total_gross_cents: number | string;
  total_tax_cents: number | string;
  total_super_cents: number | string;
  total_net_cents: number | string;
  metadata: Record<string, unknown> | null;
}

export interface StpOrg {
  id: string;
  name: string | null;
  settings: Record<string, unknown> | null;
}

export interface TerminationContext {
  employee_id: string;
  cessation_date: string;
  reason: string;
  etp?: {
    taxable_cents?: number;
    tax_free_cents?: number;
    tax_withheld_cents?: number;
  };
}

const CESSATION_TYPE_CODES: Record<string, string> = {
  genuine_redundancy: "R",
  early_retirement: "R",
  invalidity: "I",
  resignation: "V",
  retirement: "V",
  dismissal: "F",
  contract_end: "C",
  deceased: "D",
  transfer: "T",
};

const EXCLUDED_ETP_REASONS = new Set(["genuine_redundancy", "invalidity", "early_retirement"]);

/**
 * STP cessation type code for a termination reason. An unknown reason DELIBERATELY
 * defaults to V (voluntary) — a conservative fallback, not a missing-case bug; the
 * output notes tell the tax agent to confirm the code before lodgement.
 */
export function cessationTypeCode(reason: string): string {
  return CESSATION_TYPE_CODES[reason] ?? "V";
}

/** Life-benefit ETP code: R for excluded (redundancy/invalidity/early-retirement), else O. */
export function etpCode(reason: string): string {
  return EXCLUDED_ETP_REASONS.has(reason) ? "R" : "O";
}

function parseTermination(metadata: Record<string, unknown> | null): TerminationContext | null {
  const t = metadata?.["termination"] as Record<string, unknown> | undefined;
  if (!t || typeof t["employee_id"] !== "string" || typeof t["cessation_date"] !== "string") {
    return null;
  }
  const etp = (t["etp"] as Record<string, unknown> | undefined) ?? undefined;
  return {
    employee_id: t["employee_id"],
    cessation_date: t["cessation_date"],
    reason: typeof t["reason"] === "string" ? (t["reason"] as string) : "resignation",
    etp: etp
      ? {
        taxable_cents: Number(etp["taxable_cents"]) || 0,
        tax_free_cents: Number(etp["tax_free_cents"]) || 0,
        tax_withheld_cents: Number(etp["tax_withheld_cents"]) || 0,
      }
      : undefined,
  };
}

export function buildStpEvent(args: {
  run: StpRun;
  org: StpOrg | null;
  slips: StpSlip[];
  generatedBy: string;
}): Record<string, unknown> {
  const { run, org, slips, generatedBy } = args;
  const termination = parseTermination(run.metadata);
  // An ETP is only emitted alongside the terminated employee's pay slip. If that
  // employee has no slip in this run, the ETP would be silently dropped from the STP
  // file — flag it so it's included or lodged separately rather than under-reported.
  const terminatedPresent = termination
    ? slips.some((s) => s.employee.id === termination.employee_id)
    : true;

  return {
    schema: "stp_phase2_v1",
    generated_at: new Date().toISOString(),
    generated_by: generatedBy,
    header: {
      employer_abn: (org?.settings as Record<string, unknown> | null)?.["abn"] ?? null,
      employer_name: org?.name ?? null,
      bms_id: `looplet-${org?.id ?? "unknown"}`,
      software_name: "Looplet Accounting",
      software_version: "0.1",
      run_date: new Date().toISOString().slice(0, 10),
    },
    pay_event: {
      period_start: run.period_start,
      period_end: run.period_end,
      pay_date: run.pay_date,
      // Termination/cessation for the run (STP Phase 2). null for an ordinary run.
      termination: termination
        ? {
          employee_id: termination.employee_id,
          cessation_date: termination.cessation_date,
          cessation_type_code: cessationTypeCode(termination.reason),
        }
        : null,
      totals: {
        gross_cents: Number(run.total_gross_cents),
        payg_tax_cents: Number(run.total_tax_cents),
        super_cents: Number(run.total_super_cents),
        net_cents: Number(run.total_net_cents),
      },
      employees: slips.map((s) => {
        const emp = s.employee;
        const wage = (emp.wage_components ?? {}) as Record<string, unknown>;
        // OTE = Ordinary Time Earnings. Overtime is excluded from OTE for super.
        const ote = Number(s.gross_ordinary_cents) + Number(s.gross_leave_cents);
        const isTerminated = termination?.employee_id === emp.id;
        return {
          // TFN intentionally not stored in our schema — placeholder for the
          // tax agent to fill from the TFN-declaration form on file.
          tfn: (wage["tfn"] as string | undefined) ?? "000000000",
          employee_id: emp.id,
          name: emp.full_name,
          email: emp.email,
          address: {
            line1: (wage["address_line1"] as string | undefined) ?? null,
            line2: (wage["address_line2"] as string | undefined) ?? null,
            suburb: (wage["suburb"] as string | undefined) ?? null,
            state: (wage["state"] as string | undefined) ?? null,
            postcode: (wage["postcode"] as string | undefined) ?? null,
            country: "AU",
          },
          ytd: {
            gross_cents: Number(s.ytd_gross_cents),
            payg_tax_cents: Number(s.ytd_tax_cents),
            super_cents: Number(s.ytd_super_cents),
          },
          pay: {
            hours: {
              ordinary: Number(s.hours_ordinary),
              overtime: Number(s.hours_overtime),
              leave: Number(s.hours_leave),
            },
            gross_ordinary_cents: Number(s.gross_ordinary_cents),
            gross_overtime_cents: Number(s.gross_overtime_cents),
            gross_leave_cents: Number(s.gross_leave_cents),
            gross_total_cents: Number(s.gross_total_cents),
            ote_cents: ote,
            payg_tax_cents: Number(s.payg_tax_cents),
            super_guarantee_cents: Number(s.super_guarantee_cents),
            super_rate_pct: Number(s.super_rate_pct),
            net_pay_cents: Number(s.net_pay_cents),
          },
          // Employment Termination Payment (life benefit) for the terminated employee.
          etp: isTerminated && termination
            ? {
              code: etpCode(termination.reason),
              taxable_cents: termination.etp?.taxable_cents ?? 0,
              tax_free_cents: termination.etp?.tax_free_cents ?? 0,
              tax_withheld_cents: termination.etp?.tax_withheld_cents ?? 0,
            }
            : null,
          deductions: [],
        };
      }),
    },
    notes: [
      "STP Phase 2 file. Lodgement to ATO requires SBR-gateway integration " +
      "(out of scope) — hand to your registered tax/BAS agent.",
      "TFN, address, and BMS_ID fields default to placeholders if not stored.",
      ...(termination
        ? ["Termination event — cessation type + ETP codes are simplified; confirm against the actual award/ATO before lodgement."]
        : []),
      ...(termination && !terminatedPresent
        ? [
          `Termination recorded for employee ${termination.employee_id} but no pay slip is in this run — the ETP is NOT included in this STP file. Include that employee in the pay run or lodge the ETP separately.`,
        ]
        : []),
    ],
  };
}
