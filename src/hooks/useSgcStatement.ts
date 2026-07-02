import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';

export interface SgcPaySlipRow {
  pay_slip_id: string;
  pay_run_id: string;
  pay_date: string;
  gross_total_cents: number;
  ordinary_time_earnings_cents: number;
  overtime_excluded_cents: number;
  statutory_rate_pct: number;
  recorded_rate_pct: number;
  required_super_cents: number;
  payroll_super_cents: number;
}

export interface SgcEmployeeRow {
  employee_id: string;
  employee_name: string;
  slip_count: number;
  gross_total_cents: number;
  ordinary_time_earnings_cents: number;
  overtime_excluded_cents: number;
  required_super_cents: number;
  payroll_super_cents: number;
  calculation_shortfall_cents: number;
  recorded_rate_min_pct: number | null;
  recorded_rate_max_pct: number | null;
  statutory_rate_min_pct: number | null;
  statutory_rate_max_pct: number | null;
  pay_slips: SgcPaySlipRow[];
}

export interface SgcStatementPayload {
  schema_version: 'build_sgc_statement:v1';
  organization_id: string;
  fy_start_year: number;
  quarter: number;
  quarter_start: string;
  quarter_end: string;
  due_date: string;
  summary: {
    employee_count: number;
    slip_count: number;
    gross_total_cents: number;
    ordinary_time_earnings_cents: number;
    overtime_excluded_cents: number;
    required_super_cents: number;
    payroll_super_cents: number;
    calculation_shortfall_cents: number;
    shortfall_employee_count: number;
    recorded_rate_min_pct: number | null;
    recorded_rate_max_pct: number | null;
    statutory_rate_min_pct: number | null;
    statutory_rate_max_pct: number | null;
  };
  sgc_components: {
    super_shortfall_cents: number;
    nominal_interest_cents: number | null;
    nominal_interest_reason: string;
    admin_fee_cents_per_employee: number;
    admin_fee_cents: number;
    draft_total_ex_interest_cents: number;
  };
  employees: SgcEmployeeRow[];
  evidence: {
    source_tables: string[];
    calculation_basis: string;
    input_hash: string;
    source_version: 'build_sgc_statement:v1';
    source_label: string;
    source_urls: string[];
  };
  warnings: string[];
  lodgement: {
    enabled: false;
    reason: string;
  };
}

export interface SgcPeriod {
  fyStartYear: number;
  quarter: number;
}

export function latestCompletedSgcPeriod(today = new Date()): SgcPeriod {
  const month = today.getMonth() + 1;
  const year = today.getFullYear();

  if (month >= 10) return { fyStartYear: year, quarter: 1 };
  if (month >= 7) return { fyStartYear: year - 1, quarter: 4 };
  if (month >= 4) return { fyStartYear: year - 1, quarter: 3 };
  return { fyStartYear: year - 1, quarter: 2 };
}

export function sgcFyLabel(fyStartYear: number): string {
  return `FY${fyStartYear}-${String(fyStartYear + 1).slice(2)}`;
}

export function sgcQuarterLabel(quarter: number): string {
  const ranges: Record<number, string> = {
    1: 'Q1 Jul-Sep',
    2: 'Q2 Oct-Dec',
    3: 'Q3 Jan-Mar',
    4: 'Q4 Apr-Jun',
  };
  return ranges[quarter] ?? `Q${quarter}`;
}

export function useSgcStatement(fyStartYear: number | null, quarter: number | null) {
  const { currentOrg } = useOrg();
  const [sgcStatement, setSgcStatement] = useState<SgcStatementPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!currentOrg || fyStartYear == null || quarter == null) {
      setSgcStatement(null);
      setError(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    const { data, error: err } = await supabase.rpc('build_sgc_statement', {
      p_org: currentOrg.id,
      p_fy_start_year: fyStartYear,
      p_quarter: quarter,
    });

    setSgcStatement(err ? null : ((data ?? null) as unknown as SgcStatementPayload | null));
    setError(err?.message ?? null);
    setLoading(false);
  }, [currentOrg, fyStartYear, quarter]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { sgcStatement, loading, error, refresh };
}
