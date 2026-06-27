import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';

export interface CompanyOfficer {
  id: string;
  name: string;
  role: 'director' | 'secretary';
  director_id: string | null;
  appointment_date: string | null;
  cessation_date: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface ShareRegisterRow {
  id: string;
  member_name: string;
  share_class: string;
  number_held: number;
  amount_paid_cents: number;
  amount_unpaid_cents: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface AsicFiling {
  id: string;
  form_type: string;
  status: 'draft' | 'lodged' | 'accepted' | 'rejected';
  lodgement_date: string | null;
  details: Record<string, unknown>;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface AsicCalendarObligation {
  title: string;
  due_date: string;
  period_label: string;
  status: string;
}

export interface AsicForm484Draft {
  ok: boolean;
  organization_id: string;
  form_type: '484';
  status: 'draft' | 'empty' | 'not_written';
  change_count: number;
  filing_id: string | null;
  drafts_replaced?: number;
  officer_changes?: unknown[];
  share_changes?: unknown[];
  address_changes?: unknown[];
  error?: string;
}

interface AsicProfile {
  entity_type?: string | null;
  asic_review_date?: string | null;
}

/**
 * Loads the company ASIC register tables plus the annual-review calendar row. The
 * workspace is visible only for business_profile.entity_type='company', while the
 * table/RPC calls stay RLS-scoped to the org.
 */
export function useAsic() {
  const { currentOrg } = useOrg();
  const [officers, setOfficers] = useState<CompanyOfficer[]>([]);
  const [shares, setShares] = useState<ShareRegisterRow[]>([]);
  const [filings, setFilings] = useState<AsicFiling[]>([]);
  const [profile, setProfile] = useState<AsicProfile | null>(null);
  const [annualReview, setAnnualReview] = useState<AsicCalendarObligation | null>(null);
  const [lastDraft, setLastDraft] = useState<AsicForm484Draft | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!currentOrg) {
      setOfficers([]);
      setShares([]);
      setFilings([]);
      setProfile(null);
      setAnnualReview(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    const [profileRes, officersRes, sharesRes, filingsRes, calendarRes] = await Promise.all([
      supabase
        .from('business_profile')
        .select('entity_type, asic_review_date')
        .eq('organization_id', currentOrg.id)
        .maybeSingle(),
      supabase
        .from('company_officers')
        .select('id, name, role, director_id, appointment_date, cessation_date, notes, created_at, updated_at')
        .eq('organization_id', currentOrg.id)
        .is('deleted_at', null)
        .order('name', { ascending: true }),
      supabase
        .from('share_register')
        .select('id, member_name, share_class, number_held, amount_paid_cents, amount_unpaid_cents, notes, created_at, updated_at')
        .eq('organization_id', currentOrg.id)
        .is('deleted_at', null)
        .order('member_name', { ascending: true }),
      supabase
        .from('asic_filings')
        .select('id, form_type, status, lodgement_date, details, notes, created_at, updated_at')
        .eq('organization_id', currentOrg.id)
        .is('deleted_at', null)
        .order('created_at', { ascending: false }),
      supabase
        .from('v_tax_calendar')
        .select('title, due_date, period_label, status')
        .eq('organization_id', currentOrg.id)
        .eq('obligation_key', 'asic_annual_review')
        .order('due_date', { ascending: true })
        .limit(1),
    ]);

    setProfile((profileRes.data as AsicProfile | null) ?? null);
    setOfficers((officersRes.data ?? []) as CompanyOfficer[]);
    setShares((sharesRes.data ?? []) as ShareRegisterRow[]);
    setFilings((filingsRes.data ?? []) as AsicFiling[]);
    setAnnualReview(((calendarRes.data as AsicCalendarObligation[] | null) ?? [])[0] ?? null);

    const firstError = [profileRes.error, officersRes.error, sharesRes.error, filingsRes.error]
      .find(Boolean);
    setError(firstError?.message ?? null);
    setLoading(false);
  }, [currentOrg]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const directorsMissingId = useMemo(
    () => officers.filter((o) => o.role === 'director' && !o.cessation_date && !o.director_id),
    [officers],
  );

  const generateForm484Draft = useCallback(async (): Promise<AsicForm484Draft | null> => {
    if (!currentOrg) return null;
    setActionBusy(true);
    setError(null);
    const { data, error: rpcErr } = await supabase.rpc('asic_form484_draft', { p_org: currentOrg.id });
    setActionBusy(false);

    if (rpcErr) {
      setError(rpcErr.message);
      return null;
    }

    const draft = data as AsicForm484Draft;
    setLastDraft(draft);
    if (draft?.ok && draft.status !== 'empty') {
      await refresh();
    }
    return draft;
  }, [currentOrg, refresh]);

  return {
    officers,
    shares,
    filings,
    isCompany: profile?.entity_type === 'company',
    asicReviewDate: profile?.asic_review_date ?? null,
    annualReview,
    directorsMissingId,
    lastDraft,
    loading,
    error,
    actionBusy,
    refresh,
    generateForm484Draft,
  };
}
