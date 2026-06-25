import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';

// AU general depreciation methods (0093 depreciation_method enum).
export type DepreciationMethod = 'prime_cost' | 'diminishing_value';

// Asset lifecycle (0093 fixed_asset_status enum). Machine-proposed rows arrive
// 'proposed'; a human confirms to 'active' (this hook) or the asset is 'disposed'.
export type FixedAssetStatus = 'proposed' | 'active' | 'disposed';

// One fixed_assets row (0093). cost_base_cents is money-in-cents; asset_account_code
// is the advisory balance-sheet account (chart_of_accounts.code, no FK).
export interface FixedAsset {
  id: string;
  organization_id: string;
  source_bill_id: string | null;
  name: string;
  asset_account_code: string | null;
  acquisition_date: string;
  cost_base_cents: number;
  depreciation_method: DepreciationMethod;
  effective_life_years: number | null; // NULL for instant-write-off / pooled
  pool_eligible: boolean;
  instant_write_off: boolean;
  status: FixedAssetStatus;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  deleted_at: string | null;
}

// One depreciation_schedules row (0093): the depreciation plan for an asset. Holds
// its own copy of the calc inputs so compute_depreciation (0095) is self-contained.
export interface DepreciationSchedule {
  id: string;
  organization_id: string;
  fixed_asset_id: string;
  method: DepreciationMethod;
  start_date: string;
  opening_cost_base_cents: number;
  effective_life_years: number;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  deleted_at: string | null;
}

const ASSET_COLUMNS =
  'id, organization_id, source_bill_id, name, asset_account_code, acquisition_date, cost_base_cents, depreciation_method, effective_life_years, pool_eligible, instant_write_off, status, created_at, updated_at, created_by, deleted_at';
const SCHEDULE_COLUMNS =
  'id, organization_id, fixed_asset_id, method, start_date, opening_cost_base_cents, effective_life_years, created_at, updated_at, created_by, deleted_at';

// Drives the fixed-asset register (SC-1.H). Reads the live fixed_assets +
// depreciation_schedules for the active org (0093) and partitions the assets into the
// confirmed register (status active/disposed) and the proposed-capitalisation review
// list (status 'proposed', written by propose_capitalisation, 0094). fixed_assets is
// client-writable under RLS (0093 grants SELECT/INSERT/UPDATE TO authenticated), so
// confirm (proposed -> active) and reject (soft-delete) are direct table updates —
// no edge fn, unlike the read-only coding queue.
export function useFixedAssets() {
  const { currentOrg } = useOrg();
  const [allAssets, setAllAssets] = useState<FixedAsset[]>([]);
  const [schedules, setSchedules] = useState<DepreciationSchedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetch = useCallback(async () => {
    if (!currentOrg) {
      setAllAssets([]);
      setSchedules([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);

    const [assetRes, schedRes] = await Promise.all([
      supabase
        .from('fixed_assets')
        .select(ASSET_COLUMNS)
        .eq('organization_id', currentOrg.id)
        .is('deleted_at', null)
        .order('acquisition_date', { ascending: false })
        .order('created_at', { ascending: false }),
      supabase
        .from('depreciation_schedules')
        .select(SCHEDULE_COLUMNS)
        .eq('organization_id', currentOrg.id)
        .is('deleted_at', null),
    ]);

    const queryErr = assetRes.error ?? schedRes.error;
    if (queryErr) {
      setError(queryErr.message);
      setAllAssets([]);
      setSchedules([]);
    } else {
      setAllAssets((assetRes.data ?? []) as unknown as FixedAsset[]);
      setSchedules((schedRes.data ?? []) as unknown as DepreciationSchedule[]);
    }
    setLoading(false);
  }, [currentOrg]);

  useEffect(() => {
    void fetch();
  }, [fetch]);

  // Confirm a proposed capitalisation: flip proposed -> active so the depreciation
  // cron (SC-1.G.02, which inner-joins fixed_assets.status='active') begins posting
  // its schedule. Scoped to status='proposed' so confirm only ever does proposed ->
  // active — it can't resurrect a disposed asset into depreciation. Throws on error
  // so the caller can surface it; refreshes on success.
  const confirm = useCallback(
    async (assetId: string) => {
      const { error: upErr } = await supabase
        .from('fixed_assets')
        .update({ status: 'active' })
        .eq('id', assetId)
        .eq('status', 'proposed');
      if (upErr) throw new Error(upErr.message);
      await fetch();
    },
    [fetch],
  );

  // Reject a proposed capitalisation: soft-delete the asset (house convention — 0093
  // gives fixed_assets no hard-DELETE policy). The depreciation cron guards on the
  // parent asset's status/deleted_at, so its schedule stops being processed even
  // though the schedule row itself stays live (a soft delete does not cascade).
  const reject = useCallback(
    async (assetId: string) => {
      const { error: upErr } = await supabase
        .from('fixed_assets')
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', assetId);
      if (upErr) throw new Error(upErr.message);
      await fetch();
    },
    [fetch],
  );

  // Partition the single asset query into the confirmed register (active/disposed)
  // vs the machine-proposed review list — derived on return from one state var,
  // mirroring how useBooksHealth derives its views from a single row of state.
  const assets = allAssets.filter((a) => a.status !== 'proposed');
  const proposals = allAssets.filter((a) => a.status === 'proposed');

  return { assets, proposals, schedules, loading, error, refresh: fetch, confirm, reject };
}
