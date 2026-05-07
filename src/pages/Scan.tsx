import { useState, useEffect, useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/contexts/OrgContext';

interface Finding {
  id: string;
  organization_id: string;
  check_code: string;
  resource_type: string | null;
  resource_id: string | null;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  description: string | null;
  fix_url: string | null;
  fix_action: string | null;
  first_seen_at: string;
  last_seen_at: string;
  resolved_at: string | null;
  is_muted: boolean;
}

interface ScanSummary {
  ok: boolean;
  critical: number;
  warning: number;
  info: number;
  resolved_this_run: number;
  scanned_at: string;
}

const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 } as const;

export function ScanPage() {
  const { currentOrg } = useOrg();
  const [findings, setFindings] = useState<Finding[]>([]);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [summary, setSummary] = useState<ScanSummary | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const [showMuted, setShowMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!currentOrg) return;
    setLoading(true);
    let q = supabase
      .from('data_completeness_findings')
      .select('*')
      .eq('organization_id', currentOrg.id);
    if (!showResolved) q = q.is('resolved_at', null);
    if (!showMuted) q = q.eq('is_muted', false);
    const { data, error: e } = await q;
    if (e) setError(e.message);
    setFindings((data ?? []) as Finding[]);
    setLoading(false);
  }, [currentOrg, showResolved, showMuted]);

  useEffect(() => void refresh(), [refresh]);

  if (!currentOrg) return null;

  const runScan = async () => {
    setScanning(true);
    setError(null);
    const { data, error: e } = await supabase.rpc('run_data_completeness_scan', { p_org_id: currentOrg.id });
    setScanning(false);
    if (e) {
      setError(e.message);
      return;
    }
    setSummary(data as ScanSummary);
    await refresh();
  };

  const muteFinding = async (id: string, muted: boolean) => {
    const { error: e } = await supabase
      .from('data_completeness_findings')
      .update({ is_muted: muted })
      .eq('id', id);
    if (e) { setError(e.message); return; }
    await refresh();
  };

  // Group by severity
  const grouped = useMemo(() => {
    const map: Record<string, Finding[]> = { critical: [], warning: [], info: [] };
    for (const f of findings) (map[f.severity] ??= []).push(f);
    return map;
  }, [findings]);

  const totalOpen = findings.filter((f) => !f.resolved_at && !f.is_muted).length;

  return (
    <section>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ margin: 0 }}>Tax-readiness scan</h1>
          <p style={{ color: '#888', fontSize: 13, margin: '4px 0 0' }}>
            Audits your books for ATO compliance gaps, missing data, and audit risks. Runs nightly + on demand.
          </p>
        </div>
        <button
          onClick={runScan}
          disabled={scanning}
          style={{
            padding: '0.5rem 1.25rem',
            background: '#1c4868', color: '#fff',
            border: '1px solid #5096d8', borderRadius: 4,
            fontSize: 13, fontWeight: 600,
            cursor: scanning ? 'wait' : 'pointer',
          }}
        >
          {scanning ? 'Scanning…' : '↻ Run scan now'}
        </button>
      </div>

      {summary && (
        <div style={{ marginTop: 12, padding: 10, background: '#0e1820', border: '1px solid #1f3a52', borderRadius: 4, fontSize: 12, color: '#9ab0c0' }}>
          Last scan: {summary.critical} critical, {summary.warning} warnings, {summary.info} info ·
          {' '}{summary.resolved_this_run} auto-resolved · ran {new Date(summary.scanned_at).toLocaleString('en-AU')}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, maxWidth: 700, marginTop: 16 }}>
        <SummaryCard label="Critical" value={grouped.critical?.filter((f) => !f.resolved_at && !f.is_muted).length ?? 0} colour="#e9a3a3" bg="#3d1818" />
        <SummaryCard label="Warnings" value={grouped.warning?.filter((f) => !f.resolved_at && !f.is_muted).length ?? 0} colour="#d2c886" bg="#3d2818" />
        <SummaryCard label="Info" value={grouped.info?.filter((f) => !f.resolved_at && !f.is_muted).length ?? 0} colour="#7fb6e8" bg="#0e1820" />
      </div>

      <div style={{ marginTop: 16, display: 'flex', gap: 12, fontSize: 12, color: '#888' }}>
        <label>
          <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} /> Show resolved
        </label>
        <label>
          <input type="checkbox" checked={showMuted} onChange={(e) => setShowMuted(e.target.checked)} /> Show muted
        </label>
      </div>

      {error && <p style={{ color: 'salmon', marginTop: 8, fontSize: 12 }}>{error}</p>}

      {loading ? <p style={{ color: '#888', marginTop: 16 }}>Loading…</p> :
        totalOpen === 0 && !showResolved && !showMuted ? (
          <div style={{ marginTop: 24, padding: 24, background: '#0d2f1f', border: '1px solid #1c5135', borderRadius: 6, color: '#86c7a3', textAlign: 'center', fontSize: 14 }}>
            ✓ All clear — no open findings. Your books are tax-ready.
          </div>
        ) : (
          <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
            {(['critical', 'warning', 'info'] as const).map((sev) => {
              const list = (grouped[sev] ?? [])
                .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
              if (list.length === 0) return null;
              return (
                <div key={sev}>
                  <div style={{ fontSize: 11, color: '#666', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8, fontWeight: 600 }}>
                    {sev} ({list.length})
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {list.map((f) => <FindingRow key={f.id} f={f} onMute={muteFinding} />)}
                  </div>
                </div>
              );
            })}
          </div>
        )
      }
    </section>
  );
}

function FindingRow({ f, onMute }: { f: Finding; onMute: (id: string, muted: boolean) => void }) {
  const colours = {
    critical: { bg: '#1d1010', border: '#3d1818', text: '#e9a3a3' },
    warning: { bg: '#1d1810', border: '#3d2818', text: '#d2c886' },
    info: { bg: '#101820', border: '#1f3a52', text: '#7fb6e8' },
  }[f.severity];

  return (
    <div style={{
      padding: 10,
      background: f.resolved_at ? '#0e0e0e' : colours.bg,
      border: '1px solid ' + (f.resolved_at ? '#2a2a2a' : colours.border),
      borderRadius: 4,
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'flex-start',
      gap: 12,
      opacity: f.resolved_at || f.is_muted ? 0.55 : 1,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: colours.text }}>{f.title}</div>
        {f.description && (
          <div style={{ fontSize: 12, color: '#aaa', marginTop: 4, lineHeight: 1.4 }}>{f.description}</div>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 6, fontSize: 10, color: '#666' }}>
          <span>code: {f.check_code}</span>
          {f.resource_type && <span>· {f.resource_type}</span>}
          <span>· first seen: {new Date(f.first_seen_at).toLocaleDateString('en-AU')}</span>
          {f.resolved_at && <span style={{ color: '#86c7a3' }}>· ✓ resolved</span>}
          {f.is_muted && <span style={{ color: '#888' }}>· muted</span>}
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {f.fix_url && !f.resolved_at && (
          <Link
            to={f.fix_url}
            style={{
              padding: '0.3rem 0.7rem',
              background: '#1c4868', color: '#fff',
              border: '1px solid #5096d8', borderRadius: 3,
              fontSize: 11, fontWeight: 600, textDecoration: 'none', whiteSpace: 'nowrap',
            }}
          >
            {f.fix_action ?? 'Fix'} →
          </Link>
        )}
        {!f.resolved_at && (
          <button
            onClick={() => onMute(f.id, !f.is_muted)}
            style={{
              padding: '0.2rem 0.5rem',
              background: 'transparent', color: '#888',
              border: '1px solid #2a2a2a', borderRadius: 3,
              fontSize: 10, cursor: 'pointer',
            }}
            title={f.is_muted ? 'Unmute' : 'Mute permanently — won\'t alert next scan'}
          >
            {f.is_muted ? 'unmute' : 'mute'}
          </button>
        )}
      </div>
    </div>
  );
}

function SummaryCard({ label, value, colour, bg }: { label: string; value: number; colour: string; bg: string }) {
  return (
    <div style={{ padding: 12, background: bg, border: `1px solid ${colour}33`, borderRadius: 6 }}>
      <div style={{ fontSize: 10, color: colour, textTransform: 'uppercase', letterSpacing: 0.5, opacity: 0.7 }}>{label}</div>
      <div style={{ marginTop: 4, fontSize: 22, color: colour, fontWeight: 700 }}>{value}</div>
    </div>
  );
}
