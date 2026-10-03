import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';
import { DEFAULT_TIME_ZONE, localDateParts } from '@/lib/localDates';

export interface FbtRates {
  fbt_year_end_year: number;
  fbt_rate_bps: number;
  type_1_gross_up_rate_bps: number;
  type_2_gross_up_rate_bps: number;
  source_label: string;
  source_url: string | null;
}

export interface FbtBenefitRow {
  id: string;
  benefit_kind: string;
  description: string;
  employee_reference: string | null;
  taxable_value_cents: number;
  employee_contribution_cents: number;
  net_taxable_value_cents: number;
  gross_up_type: 'type_1' | 'type_2';
  is_exempt: boolean;
  exempt_reason: string | null;
  source_reference: string | null;
}

export interface FbtReturnSummary {
  type_1_taxable_value_cents: number;
  type_2_taxable_value_cents: number;
  aggregate_taxable_value_cents: number;
  employee_contributions_cents: number;
  exempt_taxable_value_cents: number;
  grossed_up_taxable_amount_cents: number;
  fbt_payable_cents: number;
}

export interface FbtReturnPayload {
  schema_version: 'build_fbt_return:v1';
  organization_id: string;
  fbt_year_end_year: number;
  period_start: string;
  period_end: string;
  due_date: string;
  registration: {
    is_fbt_registered: boolean;
    employees_count: number;
    vehicle_count: number;
    has_logbook: boolean | null;
  };
  rates: FbtRates;
  summary: FbtReturnSummary;
  benefits: FbtBenefitRow[];
  evidence: {
    source_tables: string[];
    input_hash: string;
    source_version: 'build_fbt_return:v1';
  };
  approval: {
    resource_type: 'fbt_return';
    resource_id: string;
    payload_rpc: 'fbt_return_approval_payload';
  };
  warnings: string[];
  lodgement: {
    enabled: false;
    reason: string;
  };
}

/** The FBT year ends 31 March; the latest completed one, judged on the date in Australian time. */
export function latestCompletedFbtYearEndYear(
  today = new Date(),
  timeZone = DEFAULT_TIME_ZONE,
): number {
  const { year, month } = localDateParts(today, timeZone);
  return month >= 4 ? year : year - 1;
}

export function fbtYearLabel(yearEndYear: number): string {
  return `FBT ${yearEndYear}`;
}

export function useFbtReturn(fbtYearEndYear: number | null) {
  const { currentOrg } = useOrg();
  const [fbtReturn, setFbtReturn] = useState<FbtReturnPayload | null>(null);
  const [approvalPayload, setApprovalPayload] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!currentOrg || fbtYearEndYear == null) {
      setFbtReturn(null);
      setApprovalPayload(null);
      setError(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    const [ret, approval] = await Promise.all([
      supabase.rpc('build_fbt_return', {
        p_org: currentOrg.id,
        p_fbt_year_end_year: fbtYearEndYear,
      }),
      supabase.rpc('fbt_return_approval_payload', {
        p_org: currentOrg.id,
        p_fbt_year_end_year: fbtYearEndYear,
      }),
    ]);

    setFbtReturn(ret.error ? null : ((ret.data ?? null) as unknown as FbtReturnPayload | null));
    setApprovalPayload(
      approval.error
        ? null
        : ((approval.data ?? null) as unknown as Record<string, unknown> | null),
    );

    const messages = [ret.error?.message, approval.error?.message].filter(Boolean);
    setError(messages.length ? messages.join(' · ') : null);
    setLoading(false);
  }, [currentOrg, fbtYearEndYear]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { fbtReturn, approvalPayload, loading, error, refresh };
}
