import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';

/**
 * AllocationSplitButton — sibling to MoveToOrgButton, but instead of moving
 * the row to a different org it adds split rows so the cost is attributed
 * across multiple orgs by percentage.
 *
 * Storage: public.allocation_splits (resource_type, resource_id, organization_id, percentage).
 * Host org is the row's native organization_id; its effective percentage is
 * (100 - SUM(splits.percentage)). DB trigger enforces SUM <= 100.
 *
 * UX: dropdown of "other" orgs the user belongs to, each with a percentage
 * input. Existing splits are loaded and editable. "Save splits" upserts /
 * deletes diffs in one go.
 */

export type SplitResourceType = 'bill' | 'bank_transaction' | 'subscription';

interface Props {
  resourceType: SplitResourceType;
  resourceId: string;
  /** The resource's native organization_id (host org). */
  hostOrgId: string;
  /** Optional label override. */
  label?: string;
  /** Called after splits are saved. */
  onSaved?: () => void;
}

interface SplitRow {
  id: string | null; // null = new row, not yet persisted
  organization_id: string;
  percentage: number;
  notes: string | null;
}

export function AllocationSplitButton({ resourceType, resourceId, hostOrgId, label, onSaved }: Props) {
  const { organizations } = useOrg();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [splits, setSplits] = useState<SplitRow[]>([]);
  const [originalIds, setOriginalIds] = useState<Set<string>>(new Set());

  const hostOrgName = useMemo(
    () => organizations.find((o) => o.id === hostOrgId)?.name ?? 'this business',
    [organizations, hostOrgId],
  );

  const otherOrgs = useMemo(
    () => organizations.filter((o) => o.id !== hostOrgId),
    [organizations, hostOrgId],
  );

  const loadSplits = useCallback(async () => {
    setLoading(true);
    setErr(null);
    const { data, error } = await supabase
      .from('allocation_splits')
      .select('id, organization_id, percentage, notes')
      .eq('resource_type', resourceType)
      .eq('resource_id', resourceId);
    setLoading(false);
    if (error) {
      setErr(error.message);
      return;
    }
    const rows: SplitRow[] = (data ?? []).map((r) => ({
      id: r.id as string,
      organization_id: r.organization_id as string,
      percentage: Number(r.percentage),
      notes: (r.notes as string | null) ?? null,
    }));
    setSplits(rows);
    setOriginalIds(new Set(rows.map((r) => r.id).filter((id): id is string => id !== null)));
  }, [resourceType, resourceId]);

  useEffect(() => {
    if (open) void loadSplits();
  }, [open, loadSplits]);

  if (otherOrgs.length === 0) return null;

  const totalSplit = splits.reduce((acc, s) => acc + (Number.isFinite(s.percentage) ? s.percentage : 0), 0);
  const hostShare = Math.max(0, 100 - totalSplit);
  const overTotal = totalSplit > 100;

  const addRow = (orgId: string) => {
    if (splits.some((s) => s.organization_id === orgId)) return;
    setSplits([...splits, { id: null, organization_id: orgId, percentage: 0, notes: null }]);
  };

  const updatePct = (orgId: string, raw: string) => {
    const n = parseFloat(raw);
    setSplits((prev) =>
      prev.map((s) =>
        s.organization_id === orgId
          ? { ...s, percentage: Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0 }
          : s,
      ),
    );
  };

  const updateNotes = (orgId: string, raw: string) => {
    setSplits((prev) =>
      prev.map((s) =>
        s.organization_id === orgId ? { ...s, notes: raw.trim() || null } : s,
      ),
    );
  };

  const removeRow = (orgId: string) => {
    setSplits((prev) => prev.filter((s) => s.organization_id !== orgId));
  };

  const save = async () => {
    if (overTotal) {
      setErr(`Splits sum to ${totalSplit.toFixed(2)}% (>100%). Reduce before saving.`);
      return;
    }
    if (splits.some((s) => s.percentage <= 0)) {
      setErr('Each split row needs a percentage > 0. Remove any 0% rows.');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const liveIds = new Set(splits.map((s) => s.id).filter((x): x is string => !!x));
      const toDelete = [...originalIds].filter((id) => !liveIds.has(id));
      if (toDelete.length > 0) {
        const { error: delErr } = await supabase
          .from('allocation_splits')
          .delete()
          .in('id', toDelete);
        if (delErr) throw delErr;
      }

      const inserts = splits
        .filter((s) => s.id === null)
        .map((s) => ({
          resource_type: resourceType,
          resource_id: resourceId,
          organization_id: s.organization_id,
          percentage: s.percentage,
          notes: s.notes,
        }));
      if (inserts.length > 0) {
        const { error: insErr } = await supabase.from('allocation_splits').insert(inserts);
        if (insErr) throw insErr;
      }

      const updates = splits.filter((s): s is SplitRow & { id: string } => s.id !== null);
      for (const u of updates) {
        const { error: updErr } = await supabase
          .from('allocation_splits')
          .update({ percentage: u.percentage, notes: u.notes })
          .eq('id', u.id);
        if (updErr) throw updErr;
      }

      await loadSplits();
      onSaved?.();
      setOpen(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const availableOrgs = otherOrgs.filter((o) => !splits.some((s) => s.organization_id === o.id));

  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <button
        onClick={() => setOpen(!open)}
        disabled={busy}
        style={{
          padding: '0.3rem 0.75rem',
          background: splits.length > 0 ? '#1c2c4868' : 'transparent',
          color: splits.length > 0 ? '#5096d8' : '#aaa',
          border: '1px solid ' + (splits.length > 0 ? '#5096d8' : '#333'),
          borderRadius: 3,
          fontSize: 12,
          cursor: busy ? 'wait' : 'pointer',
        }}
        title="Split this cost across multiple businesses by percentage"
      >
        {busy ? 'Saving…' : (label ?? `⊟ Split${splits.length > 0 ? ` (${splits.length})` : ''}`)}
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            right: 0,
            marginTop: 4,
            minWidth: 360,
            background: '#1a1a1a',
            border: '1px solid #2a2a2a',
            borderRadius: 4,
            boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
            zIndex: 100,
            padding: '0.5rem 0.75rem',
          }}
        >
          <div
            style={{
              fontSize: 11,
              color: '#666',
              textTransform: 'uppercase',
              letterSpacing: 0.5,
              marginBottom: 6,
            }}
          >
            Split this {resourceType.replace(/_/g, ' ')} across businesses
          </div>

          {loading ? (
            <p style={{ fontSize: 12, color: '#888', margin: '0.5rem 0' }}>Loading splits…</p>
          ) : (
            <>
              {/* Host row — implicit, not editable as a split row */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '0.4rem 0',
                  borderBottom: '1px solid #2a2a2a',
                  fontSize: 12,
                }}
              >
                <span style={{ color: '#86c7a3' }}>★ {hostOrgName} <span style={{ color: '#666' }}>(host)</span></span>
                <span style={{ color: '#86c7a3', fontWeight: 600 }}>{hostShare.toFixed(2)}%</span>
              </div>

              {splits.map((s) => {
                const org = organizations.find((o) => o.id === s.organization_id);
                return (
                  <div
                    key={s.organization_id}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 3,
                      padding: '0.5rem 0',
                      borderBottom: '1px solid #1a1a1a',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                      <span style={{ fontSize: 12, color: '#ddd' }}>
                        {org?.name ?? s.organization_id.slice(0, 8)}
                      </span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <input
                          type="number"
                          min={0}
                          max={100}
                          step="0.01"
                          value={s.percentage}
                          onChange={(e) => updatePct(s.organization_id, e.target.value)}
                          style={{
                            width: 70,
                            padding: '3px 5px',
                            background: '#000',
                            color: '#ddd',
                            border: '1px solid #333',
                            borderRadius: 3,
                            fontSize: 12,
                            textAlign: 'right',
                          }}
                        />
                        <span style={{ fontSize: 12, color: '#888' }}>%</span>
                        <button
                          onClick={() => removeRow(s.organization_id)}
                          style={{
                            marginLeft: 4,
                            padding: '0.15rem 0.4rem',
                            background: 'transparent',
                            color: '#888',
                            border: '1px solid #333',
                            borderRadius: 3,
                            fontSize: 11,
                            cursor: 'pointer',
                          }}
                          title="Remove this split row"
                        >
                          ×
                        </button>
                      </div>
                    </div>
                    <input
                      placeholder="optional notes (why split?)"
                      value={s.notes ?? ''}
                      onChange={(e) => updateNotes(s.organization_id, e.target.value)}
                      style={{
                        width: '100%',
                        padding: '3px 5px',
                        background: '#000',
                        color: '#aaa',
                        border: '1px solid #222',
                        borderRadius: 3,
                        fontSize: 11,
                        boxSizing: 'border-box',
                      }}
                    />
                  </div>
                );
              })}

              {availableOrgs.length > 0 && (
                <div style={{ marginTop: 6 }}>
                  <select
                    onChange={(e) => {
                      if (e.target.value) addRow(e.target.value);
                      e.currentTarget.value = '';
                    }}
                    defaultValue=""
                    style={{
                      width: '100%',
                      padding: '5px 8px',
                      background: '#000',
                      color: '#ddd',
                      border: '1px solid #333',
                      borderRadius: 3,
                      fontSize: 12,
                    }}
                  >
                    <option value="" disabled>
                      + add another business…
                    </option>
                    {availableOrgs.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name} ({o.organization_type})
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'baseline',
                  marginTop: 8,
                  fontSize: 12,
                  color: overTotal ? 'salmon' : '#aaa',
                  fontWeight: 600,
                }}
              >
                <span>Total split</span>
                <span>
                  {totalSplit.toFixed(2)}% {overTotal && '(over!)'}
                </span>
              </div>

              <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
                <button
                  onClick={save}
                  disabled={busy || overTotal}
                  style={{
                    flex: 1,
                    padding: '0.4rem',
                    background: overTotal ? '#3d1818' : '#1c4868',
                    color: '#fff',
                    border: '1px solid ' + (overTotal ? '#7d3838' : '#5096d8'),
                    borderRadius: 3,
                    fontSize: 12,
                    fontWeight: 600,
                    cursor: busy || overTotal ? 'not-allowed' : 'pointer',
                  }}
                >
                  {busy ? 'Saving…' : 'Save splits'}
                </button>
                <button
                  onClick={() => setOpen(false)}
                  disabled={busy}
                  style={{
                    padding: '0.4rem 0.75rem',
                    background: 'transparent',
                    color: '#888',
                    border: '1px solid #333',
                    borderRadius: 3,
                    fontSize: 12,
                    cursor: 'pointer',
                  }}
                >
                  cancel
                </button>
              </div>
              {err && (
                <p style={{ margin: '0.5rem 0 0', color: 'salmon', fontSize: 11 }}>{err}</p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
