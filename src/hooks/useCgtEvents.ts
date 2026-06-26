import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';

// 0138 cgt_asset_type enum.
export type CgtAssetType =
  | 'share'
  | 'real_property'
  | 'crypto'
  | 'collectable'
  | 'personal_use'
  | 'business_asset'
  | 'other';

// One cgt_events row (0138). All *_cents are money-in-cents (BIGINT). The cost
// base is stored as the FIVE ITAA-1997 s110-25 elements separately (not summed in
// the table) — costBaseCents() sums them. The real netting / 12-month discount /
// concessions are the calc slices (SC-4.E / 4.F); this hook is capture + correct.
export interface CgtEvent {
  id: string;
  organization_id: string;
  fixed_asset_id: string | null;
  asset_description: string;
  asset_type: CgtAssetType;
  event_type: string; // CGT-event code, e.g. 'A1' (DB CHECK: ^[A-L][0-9]{1,2}$)
  acquisition_date: string | null; // null = unknown → discount-ineligible (SC-4.E.02)
  disposal_date: string; // the CGT event date; drives the FY the gain falls in
  proceeds_cents: number;
  acquisition_cost_cents: number; // element 1
  incidental_costs_cents: number; // element 2
  ownership_costs_cents: number; // element 3 (excluded from the reduced cost base)
  capital_improvement_cents: number; // element 4
  title_costs_cents: number; // element 5
  notes: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  deleted_at: string | null;
}

const COLUMNS =
  'id, organization_id, fixed_asset_id, asset_description, asset_type, event_type, acquisition_date, disposal_date, proceeds_cents, acquisition_cost_cents, incidental_costs_cents, ownership_costs_cents, capital_improvement_cents, title_costs_cents, notes, created_at, updated_at, created_by, deleted_at';

// The fields a user fills in when recording/correcting an event. Identity + audit
// columns (id, organization_id, timestamps, created_by) are set by the hook/DB.
export type CgtEventInput = Pick<
  CgtEvent,
  | 'fixed_asset_id'
  | 'asset_description'
  | 'asset_type'
  | 'event_type'
  | 'acquisition_date'
  | 'disposal_date'
  | 'proceeds_cents'
  | 'acquisition_cost_cents'
  | 'incidental_costs_cents'
  | 'ownership_costs_cents'
  | 'capital_improvement_cents'
  | 'title_costs_cents'
  | 'notes'
>;

// Total cost base = sum of the five s110-25 elements (money-in-cents). The calc
// (SC-4.E) computes the gain as proceeds − this; the *reduced* cost base used for
// a capital LOSS excludes element 3 (ownership costs) and is the calc's concern.
export function costBaseCents(e: CgtEvent): number {
  return (
    e.acquisition_cost_cents +
    e.incidental_costs_cents +
    e.ownership_costs_cents +
    e.capital_improvement_cents +
    e.title_costs_cents
  );
}

// Drives the CGT-events panel (SC-4.D.02). Reads the live cgt_events for the
// active org (0138), which is client-writable under RLS (0138 grants
// SELECT/INSERT/UPDATE/DELETE TO authenticated via get_accessible_org_ids()), so
// create/update/remove are direct table writes — no edge fn. Soft-delete matches
// the house convention and the calc/listing both filter deleted_at IS NULL.
export function useCgtEvents() {
  const { currentOrg } = useOrg();
  const [events, setEvents] = useState<CgtEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetch = useCallback(async () => {
    if (!currentOrg) {
      setEvents([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);

    const { data, error: queryErr } = await supabase
      .from('cgt_events')
      .select(COLUMNS)
      .eq('organization_id', currentOrg.id)
      .is('deleted_at', null)
      .order('disposal_date', { ascending: false })
      .order('created_at', { ascending: false });

    if (queryErr) {
      setError(queryErr.message);
      setEvents([]);
    } else {
      setEvents((data ?? []) as unknown as CgtEvent[]);
    }
    setLoading(false);
  }, [currentOrg]);

  useEffect(() => {
    void fetch();
  }, [fetch]);

  // Record a new event. organization_id comes from the active org; the DB fills
  // the identity/audit columns. Throws on error so the caller can surface it.
  const create = useCallback(
    async (input: CgtEventInput) => {
      if (!currentOrg) throw new Error('No organisation selected');
      const { error: insErr } = await supabase
        .from('cgt_events')
        .insert({ ...input, organization_id: currentOrg.id });
      if (insErr) throw new Error(insErr.message);
      await fetch();
    },
    [currentOrg, fetch],
  );

  // Correct an existing event. RLS scopes the update to the caller's org.
  const update = useCallback(
    async (id: string, input: CgtEventInput) => {
      const { error: upErr } = await supabase.from('cgt_events').update(input).eq('id', id);
      if (upErr) throw new Error(upErr.message);
      await fetch();
    },
    [fetch],
  );

  // Soft-delete (house convention — the row survives for audit; the calc/listing
  // filter deleted_at IS NULL).
  const remove = useCallback(
    async (id: string) => {
      const { error: delErr } = await supabase
        .from('cgt_events')
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', id);
      if (delErr) throw new Error(delErr.message);
      await fetch();
    },
    [fetch],
  );

  return { events, loading, error, refresh: fetch, create, update, remove };
}
