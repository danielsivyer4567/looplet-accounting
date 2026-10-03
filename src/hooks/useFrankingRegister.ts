import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';
import { DEFAULT_TIME_ZONE, localDateParts } from '@/lib/localDates';

export interface FrankingAccountEntry {
  id: string;
  entry_date: string;
  entry_kind: string;
  description: string;
  credit_cents: number;
  debit_cents: number;
  source_table: string | null;
  source_id: string | null;
  source_reference: string | null;
}

export interface DividendStatementRow {
  id: string;
  statement_date: string;
  dividend_date: string;
  member_name: string;
  share_class: string;
  shares_held: number;
  cash_dividend_cents: number;
  franking_credit_cents: number;
  franking_percentage_bps: number;
  company_tax_rate_bps: number;
  statement_status: 'draft' | 'issued' | 'void';
  input_hash: string | null;
}

export interface FrankingRegisterPayload {
  schema_version: 'build_franking_register:v1';
  organization_id: string;
  fy_start_year: number;
  period_start: string;
  period_end: string;
  summary: {
    opening_balance_cents: number;
    credit_cents: number;
    debit_cents: number;
    closing_balance_cents: number;
    statement_cash_dividend_cents: number;
    statement_franking_credit_cents: number;
    register_distribution_debit_cents: number;
    statement_vs_register_variance_cents: number;
    gl_dividend_cents: number;
    statement_vs_gl_variance_cents: number;
    benchmark_franking_percentage_bps: number | null;
    benchmark_variation_count: number;
  };
  entries: FrankingAccountEntry[];
  dividend_statements: DividendStatementRow[];
  evidence: {
    source_tables: string[];
    input_hash: string;
    source_version: 'build_franking_register:v1';
    source_label: string;
    source_url: string | null;
  };
  warnings: string[];
  lodgement: {
    enabled: false;
    reason: string;
  };
}

/** Most recent completed AU financial year start year, judged on the date in Australian time. */
export function latestCompletedFrankingFyStartYear(
  today = new Date(),
  timeZone = DEFAULT_TIME_ZONE,
): number {
  const { year, month } = localDateParts(today, timeZone);
  return month >= 7 ? year - 1 : year - 2;
}

export function frankingFyLabel(fyStartYear: number): string {
  return `FY${fyStartYear}-${String(fyStartYear + 1).slice(2)}`;
}

export function useFrankingRegister(fyStartYear: number | null) {
  const { currentOrg } = useOrg();
  const [frankingRegister, setFrankingRegister] = useState<FrankingRegisterPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!currentOrg || fyStartYear == null) {
      setFrankingRegister(null);
      setError(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    const { data, error: err } = await supabase.rpc('build_franking_register', {
      p_org: currentOrg.id,
      p_fy_start_year: fyStartYear,
    });

    setFrankingRegister(err ? null : ((data ?? null) as unknown as FrankingRegisterPayload | null));
    setError(err?.message ?? null);
    setLoading(false);
  }, [currentOrg, fyStartYear]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { frankingRegister, loading, error, refresh };
}
