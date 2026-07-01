// Pure logic for accruals-run (SC-1.I.03), split out of index.ts so it is
// unit-testable without a Deno.serve/Supabase runtime — mirrors the
// payroll-export-stp/stp.ts and depreciation-run/logic.ts splits.

// Cadence -> number of monthly periods to spread across. MUST stay in sync with the
// CASE inside accrue_recurring_bill (0098): that CASE is only a fallback for a NULL
// p_periods, whereas the driver always passes p_periods EXPLICITLY (forward note b)
// to avoid the RPC re-running detect_recurring_bills per bill — so the mapping lives
// in both places by design. Cadences mapping to 1 (monthly/fortnightly/weekly) have
// no multi-period spread and are skipped (forward note c).
export const CADENCE_PERIODS: Record<string, number> = {
  yearly: 12,
  semi_annual: 6,
  quarterly: 3,
  monthly: 1,
  fortnightly: 1,
  weekly: 1,
};

// Only the fields the driver needs from detect_recurring_bills (SC-1.I.01).
export interface RecurringSeries {
  cadence: string;
  bill_ids: string[];
}

export interface AccrualJob {
  billId: string;
  periods: number;
}

export interface AccrualPlan {
  jobs: AccrualJob[];
  skippedShortCadence: number;
}

// SELECTION POLICY: only the most-recent bill (bill_ids' last element,
// chronological asc per 0098) is accrued, never the whole back-catalogue —
// accruals are forward-facing (see accruals-run/index.ts header for the full
// rationale). A series whose cadence isn't in CADENCE_PERIODS or maps to <= 1
// period (monthly/fortnightly/weekly — no real spread) is skipped. A series
// with an empty bill_ids array yields no job for that series.
export function planAccrualJobs(series: RecurringSeries[]): AccrualPlan {
  const jobs: AccrualJob[] = [];
  let skippedShortCadence = 0;
  for (const s of series) {
    const periods = CADENCE_PERIODS[s.cadence];
    if (!periods || periods <= 1) {
      skippedShortCadence += 1;
      continue;
    }
    const billId = s.bill_ids[s.bill_ids.length - 1];
    if (billId) jobs.push({ billId, periods });
  }
  return { jobs, skippedShortCadence };
}
