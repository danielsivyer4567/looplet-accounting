import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';

export interface TparPaymentRow {
  bill_id: string;
  invoice_number: string | null;
  invoice_date: string | null;
  payment_date: string;
  gross_paid_cents: number;
  gst_component_cents: number | null;
  source_kind: 'bills.paid_at' | 'payment_run_items';
}

export interface TparSupplierRow {
  supplier_key: string;
  supplier_id: string | null;
  supplier_name: string;
  supplier_abn: string | null;
  gross_paid_cents: number;
  gst_component_cents: number;
  net_paid_cents: number;
  payment_count: number;
  bill_count: number;
  first_payment_date: string | null;
  last_payment_date: string | null;
  missing_abn: boolean;
  missing_gst_count: number;
  payments: TparPaymentRow[];
}

export interface TparReportPayload {
  schema_version: 'build_tpar_report:v1';
  organization_id: string;
  fy_start_year: number;
  period_start: string;
  period_end: string;
  due_date: string;
  obligation: {
    is_tpar_required: boolean;
    subbies_count: number;
    source_label: string;
    source_url: string | null;
  };
  summary: {
    supplier_count: number;
    payment_count: number;
    bill_count: number;
    gross_paid_cents: number;
    gst_component_cents: number;
    net_paid_cents: number;
    missing_abn_count: number;
    missing_gst_count: number;
  };
  suppliers: TparSupplierRow[];
  evidence: {
    source_tables: string[];
    reportable_basis: string;
    input_hash: string;
    source_version: 'build_tpar_report:v1';
  };
  warnings: string[];
  export: {
    format: 'csv';
    enabled: boolean;
    filename: string;
  };
  lodgement: {
    enabled: false;
    reason: string;
  };
}

/** Most recent completed AU financial year start year. FY runs 1 July - 30 June. */
export function latestCompletedTparFyStartYear(today = new Date()): number {
  return today.getMonth() >= 6 ? today.getFullYear() - 1 : today.getFullYear() - 2;
}

export function tparFyLabel(fyStartYear: number): string {
  return `FY${fyStartYear}-${String(fyStartYear + 1).slice(2)}`;
}

export function useTparReport(fyStartYear: number | null) {
  const { currentOrg } = useOrg();
  const [tparReport, setTparReport] = useState<TparReportPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!currentOrg || fyStartYear == null) {
      setTparReport(null);
      setError(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    const { data, error: err } = await supabase.rpc('build_tpar_report', {
      p_org: currentOrg.id,
      p_fy_start_year: fyStartYear,
    });

    setTparReport(err ? null : ((data ?? null) as unknown as TparReportPayload | null));
    setError(err?.message ?? null);
    setLoading(false);
  }, [currentOrg, fyStartYear]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { tparReport, loading, error, refresh };
}
