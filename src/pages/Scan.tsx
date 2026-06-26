import { useState, useEffect, useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';
import { ShieldAlert, AlertTriangle, Info, Play, Eye, EyeOff, ShieldCheck, Loader2, type LucideIcon } from 'lucide-react';
import { InsightAreaChart, InsightBarList, InsightPanel } from '@/components/InsightCharts';
import { AnimatedNumber } from '@/components/AnimatedNumber';
import { SkeletonTable } from '@/components/Skeleton';

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
  const [scanProgress, setScanProgress] = useState(0);
  const [scanStatus, setScanStatus] = useState('');
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

  const grouped = useMemo<Record<Finding['severity'], Finding[]>>(() => {
    const map: Record<Finding['severity'], Finding[]> = { critical: [], warning: [], info: [] };
    for (const f of findings) (map[f.severity] ??= []).push(f);
    return map;
  }, [findings]);

  if (!currentOrg) return null;

  const runScan = async () => {
    setScanning(true);
    setScanProgress(0);
    setError(null);
    setFindings([]);
    setSummary(null);
    setLoading(true);

    // Dynamic scanning status stages
    const statuses = [
      'Auditing invoice integrity & GST treatment…',
      'Checking supplier tax file declarations…',
      'Verifying payroll superannuation compliance…',
      'Cross-referencing ledger entries against ATO rules…',
      'Compiling compliance risk score and summary…'
    ];

    let progressInterval: NodeJS.Timeout;
    const startTime = Date.now();
    const minDuration = 2400; // Enforce a 2.4s scan to feel deliberate and thorough

    // Start animating the progress bar
    progressInterval = setInterval(() => {
      setScanProgress((prev) => {
        if (prev >= 98) {
          clearInterval(progressInterval);
          return 98;
        }
        const step = Math.max(1, Math.round((100 - prev) * 0.15));
        const nextProgress = prev + step;
        
        // Cycle statuses based on progress range
        const statusIdx = Math.min(statuses.length - 1, Math.floor(nextProgress / 20));
        setScanStatus(statuses[statusIdx] || '');
        
        return nextProgress;
      });
    }, 120);

    try {
      const { data, error: e } = await supabase.rpc('run_data_completeness_scan', { p_org_id: currentOrg.id });
      
      const elapsedTime = Date.now() - startTime;
      if (elapsedTime < minDuration) {
        await new Promise((resolve) => setTimeout(resolve, minDuration - elapsedTime));
      }

      clearInterval(progressInterval);
      setScanProgress(100);
      setScanStatus('Audit complete!');

      // Give a tiny moment for user to see the 100% state before rendering results
      await new Promise((resolve) => setTimeout(resolve, 300));

      if (e) {
        setError(e.message);
        setScanning(false);
        setLoading(false);
        return;
      }
      setSummary(data as ScanSummary);
      setScanning(false);
      await refresh();
    } catch (err: any) {
      clearInterval(progressInterval);
      setError(err.message || 'An unexpected error occurred during scan.');
      setScanning(false);
      setLoading(false);
    }
  };

  const muteFinding = async (id: string, muted: boolean) => {
    const { error: e } = await supabase
      .from('data_completeness_findings')
      .update({ is_muted: muted })
      .eq('id', id);
    if (e) { setError(e.message); return; }
    await refresh();
  };

  const totalOpen = findings.filter((f) => !f.resolved_at && !f.is_muted).length;
  const severityItems = [
    { label: 'Critical', value: grouped.critical.length, tone: 'danger' as const },
    { label: 'Warning', value: grouped.warning.length, tone: 'warning' as const },
    { label: 'Info', value: grouped.info.length, tone: 'info' as const },
  ];
  let runningRiskScore = 0;
  let runningCriticalScore = 0;
  let runningWarningScore = 0;
  const findingTrendSource = findings.slice().sort((a, b) => a.first_seen_at.localeCompare(b.first_seen_at));
  const riskTrendItems = findings.length
    ? findingTrendSource.map((finding) => {
          runningRiskScore += finding.severity === 'critical' ? 3 : finding.severity === 'warning' ? 2 : 1;
          return {
            label: new Date(finding.first_seen_at).toLocaleDateString('en-AU', { day: '2-digit', month: 'short' }),
            value: runningRiskScore,
          };
        })
    : [{ label: 'Clear', value: 0 }];
  const criticalTrendItems = findingTrendSource.map((finding) => {
    if (finding.severity === 'critical') runningCriticalScore += 3;
    return {
      label: new Date(finding.first_seen_at).toLocaleDateString('en-AU', { day: '2-digit', month: 'short' }),
      value: runningCriticalScore,
    };
  });
  const warningTrendItems = findingTrendSource.map((finding) => {
    if (finding.severity === 'warning') runningWarningScore += 2;
    return {
      label: new Date(finding.first_seen_at).toLocaleDateString('en-AU', { day: '2-digit', month: 'short' }),
      value: runningWarningScore,
    };
  });

  return (
    <section className="animated-fade-in" style={{ position: 'relative' }}>
      {/* Dynamic Laser Scanning Overlay */}
      {scanning && (
        <div
          className="glass-panel"
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 40,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(6, 9, 19, 0.92)',
            backdropFilter: 'blur(16px)',
            borderRadius: 'var(--radius-lg)',
            padding: '2.5rem',
            textAlign: 'center',
            overflow: 'hidden',
            minHeight: '400px',
            animation: 'fadeInEffect 0.3s ease-out'
          }}
        >
          {/* Sweeping Laser Beam Line */}
          <div
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              height: '3px',
              background: 'linear-gradient(90deg, transparent, var(--accent-primary), transparent)',
              boxShadow: '0 0 16px var(--accent-primary), 0 0 8px var(--accent-primary)',
              animation: 'laserSweep 2s ease-in-out infinite',
              pointerEvents: 'none'
            }}
          />
          
          {/* Animated Radar concentric rings backdrop */}
          <div style={{
            position: 'absolute',
            width: '320px',
            height: '320px',
            borderRadius: '50%',
            border: '1px solid rgba(0, 117, 255, 0.1)',
            background: 'radial-gradient(circle, rgba(0, 117, 255, 0.05) 0%, transparent 70%)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            animation: 'radarPulse 3s linear infinite',
            pointerEvents: 'none',
            zIndex: -1
          }}>
            <div style={{
              width: '220px',
              height: '220px',
              borderRadius: '50%',
              border: '1px dashed rgba(0, 117, 255, 0.15)',
            }} />
            <div style={{
              width: '120px',
              height: '120px',
              borderRadius: '50%',
              border: '1px solid rgba(0, 117, 255, 0.2)',
            }} />
          </div>

          <style>{`
            @keyframes laserSweep {
              0% { top: 0%; }
              50% { top: 100%; }
              100% { top: 0%; }
            }
            @keyframes radarPulse {
              0% { transform: scale(0.9); opacity: 0.6; }
              50% { transform: scale(1.05); opacity: 0.9; }
              100% { transform: scale(0.9); opacity: 0.6; }
            }
            @keyframes indicatorPing {
              0% { transform: scale(0.8); opacity: 0.5; }
              50% { transform: scale(1.8); opacity: 0; }
              100% { transform: scale(0.8); opacity: 0; }
            }
            @keyframes buttonPulseRing {
              0% { box-shadow: 0 0 0 0 rgba(0, 117, 255, 0.5); }
              70% { box-shadow: 0 0 0 10px rgba(0, 117, 255, 0); }
              100% { box-shadow: 0 0 0 0 rgba(0, 117, 255, 0); }
            }
          `}</style>

          <div style={{ maxWidth: '400px', width: '100%', display: 'flex', flexDirection: 'column', gap: '1.5rem', alignItems: 'center' }}>
            <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Loader2 className="spin" size={48} style={{ color: 'var(--accent-primary)' }} />
              <ShieldAlert size={20} style={{ position: 'absolute', color: 'var(--accent-primary)' }} />
            </div>
            
            <div>
              <h3 style={{ margin: '0 0 0.5rem 0', fontSize: '1.25rem' }}>Performing Tax-Readiness Scan</h3>
              <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem', margin: 0 }}>
                Auditing organization compliance against Australian tax regulations.
              </p>
            </div>

            {/* Premium Progress Bar Container */}
            <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.5rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', fontWeight: 600 }}>
                <span style={{ color: 'var(--accent-primary)' }}>{scanStatus}</span>
                <span style={{ color: 'var(--text-title)' }}>{scanProgress}%</span>
              </div>
              <div
                style={{
                  height: '6px',
                  background: 'rgba(255, 255, 255, 0.05)',
                  borderRadius: 'var(--radius-full)',
                  overflow: 'hidden',
                  border: '1px solid var(--border-subtle)'
                }}
              >
                <div
                  style={{
                    height: '100%',
                    width: `${scanProgress}%`,
                    background: 'linear-gradient(90deg, var(--accent-primary-hover), var(--accent-primary))',
                    boxShadow: '0 0 8px var(--accent-primary)',
                    borderRadius: 'var(--radius-full)',
                    transition: 'width 0.15s cubic-bezier(0.4, 0, 0.2, 1)'
                  }}
                />
              </div>
            </div>
          </div>
        </div>
      )}

      <div 
        style={{ 
          display: 'flex', 
          justifyContent: 'space-between', 
          alignItems: 'center', 
          flexWrap: 'wrap', 
          gap: '1rem',
          marginBottom: '1.5rem'
        }}
      >
        <div>
          <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap' }}>
            <h1 style={{ margin: 0 }}>Tax-Readiness Scan</h1>
            <span className="badge" style={{
              marginLeft: '0.75rem',
              background: 'rgba(52, 211, 153, 0.08)',
              border: '1px solid rgba(52, 211, 153, 0.25)',
              color: 'var(--accent-success)',
              boxShadow: '0 0 8px rgba(52, 211, 153, 0.15)',
              padding: '0.25rem 0.6rem',
              borderRadius: 'var(--radius-full)',
              fontSize: '0.65rem',
              letterSpacing: '0.075em',
              fontWeight: 800,
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.35rem',
              height: '22px'
            }}>
              <span style={{ position: 'relative', display: 'inline-flex', width: '6px', height: '6px' }}>
                <span style={{ animation: 'indicatorPing 1.5s cubic-bezier(0, 0, 0.2, 1) infinite', position: 'absolute', display: 'inline-flex', borderRadius: '50%', height: '100%', width: '100%', background: 'var(--accent-success)', opacity: 0.75 }} />
                <span style={{ position: 'absolute', display: 'inline-flex', borderRadius: '50%', height: '6px', width: '6px', background: 'var(--accent-success)' }} />
              </span>
              AI AUDIT ACTIVE
            </span>
          </div>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem', marginTop: '0.35rem', marginBottom: 0 }}>
            Audits your books for ATO compliance gaps, missing data, and audit risks.
          </p>
        </div>

        {/* High-emphasis Pulse Run Button */}
        <div style={{ position: 'relative', display: 'inline-block' }}>
          {!scanning && (
            <div style={{
              position: 'absolute',
              inset: 0,
              borderRadius: '9999px',
              animation: 'buttonPulseRing 2s cubic-bezier(0.25, 0, 0, 1) infinite',
              pointerEvents: 'none'
            }} />
          )}
          <button
            onClick={runScan}
            disabled={scanning}
            className="btn"
            style={{
              padding: '0.75rem 1.6rem',
              background: 'linear-gradient(135deg, var(--accent-primary) 0%, #0056cc 100%)',
              color: '#ffffff',
              borderRadius: '9999px',
              fontWeight: 700,
              boxShadow: '0 4px 14px rgba(0, 117, 255, 0.35)',
              border: '1px solid rgba(255, 255, 255, 0.1)',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.5rem',
              transition: 'var(--transition-smooth)'
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = 'scale(1.04) translateY(-1px)';
              e.currentTarget.style.boxShadow = '0 6px 18px rgba(0, 117, 255, 0.45)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = 'scale(1) translateY(0)';
              e.currentTarget.style.boxShadow = '0 4px 14px rgba(0, 117, 255, 0.35)';
            }}
          >
            <Play size={14} fill="currentColor" />
            {scanning ? 'Running scan…' : 'Run scan now'}
          </button>
        </div>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
          gap: '1rem',
          marginBottom: '1.5rem',
        }}
      >
        <InsightPanel title="Readiness pulse" eyebrow="Open findings">
          <InsightAreaChart
            title="Risk load"
            items={riskTrendItems}
            tone={grouped.critical.length > 0 ? 'danger' : grouped.warning.length > 0 ? 'warning' : 'success'}
            series={[
              { label: 'Critical', items: criticalTrendItems, tone: 'danger' },
              { label: 'Warning', items: warningTrendItems, tone: 'warning' },
            ]}
            markerLabel={`${totalOpen} open`}
            formatValue={(value) => value.toLocaleString('en-AU')}
          />
        </InsightPanel>
        <InsightPanel title="Fix priority" eyebrow="Top-down queue">
          <InsightBarList
            items={severityItems.map((item) => ({
              ...item,
              detail:
                item.label === 'Critical'
                  ? 'Blocks trustworthy lodgement or financial decisions'
                  : item.label === 'Warning'
                    ? 'Should be cleared before relying on the books'
                    : 'Context and hygiene checks',
            }))}
            formatValue={(value) => value.toLocaleString('en-AU')}
          />
        </InsightPanel>
      </div>

      {summary && (
        <div 
          className="badge badge-info" 
          style={{ 
            width: '100%', 
            padding: '0.75rem 1rem', 
            marginBottom: '1.5rem', 
            justifyContent: 'flex-start',
            textTransform: 'none',
            fontSize: '0.825rem',
            lineHeight: '1.4'
          }}
        >
          🔍 Last scan summary: {summary.critical} critical, {summary.warning} warnings, {summary.info} info · {summary.resolved_this_run} auto-resolved · ran {new Date(summary.scanned_at).toLocaleString('en-AU')}
        </div>
      )}

      {/* Severity Counters Grid */}
      <div 
        style={{ 
          display: 'grid', 
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', 
          gap: '1rem', 
          marginBottom: '1.5rem' 
        }}
      >
        <SummaryCard 
          label="Critical Risks" 
          value={grouped.critical?.filter((f) => !f.resolved_at && !f.is_muted).length ?? 0} 
          type="critical" 
          icon={ShieldAlert}
        />
        <SummaryCard 
          label="Warnings" 
          value={grouped.warning?.filter((f) => !f.resolved_at && !f.is_muted).length ?? 0} 
          type="warning" 
          icon={AlertTriangle}
        />
        <SummaryCard 
          label="Info Items" 
          value={grouped.info?.filter((f) => !f.resolved_at && !f.is_muted).length ?? 0} 
          type="info" 
          icon={Info}
        />
      </div>

      {/* Filters & Checkboxes */}
      <div 
        style={{ 
          display: 'flex', 
          gap: '1.25rem', 
          fontSize: '0.825rem', 
          color: 'var(--text-muted)', 
          background: 'var(--bg-panel)',
          padding: '0.75rem 1rem',
          borderRadius: 'var(--radius-sm)',
          border: '1px solid var(--border-subtle)',
          marginBottom: '1.5rem',
          alignItems: 'center'
        }}
      >
        <span style={{ fontWeight: 600, color: 'var(--text-title)' }}>Filters:</span>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', cursor: 'pointer' }}>
          <input 
            type="checkbox" 
            checked={showResolved} 
            onChange={(e) => setShowResolved(e.target.checked)} 
            style={{ cursor: 'pointer' }}
          />
          Show resolved findings
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', cursor: 'pointer' }}>
          <input 
            type="checkbox" 
            checked={showMuted} 
            onChange={(e) => setShowMuted(e.target.checked)} 
            style={{ cursor: 'pointer' }}
          />
          Show muted items
        </label>
      </div>

      {error && (
        <div className="badge badge-danger" style={{ display: 'block', padding: '0.75rem', marginBottom: '1.5rem', textTransform: 'none' }}>
          {error}
        </div>
      )}

      {loading ? (
        <SkeletonTable rows={5} cols={4} />
      ) : totalOpen === 0 && !showResolved && !showMuted ? (
        <div 
          style={{ 
            padding: '3rem 2rem', 
            background: 'var(--bg-success-subtle)', 
            border: '1px dashed var(--accent-success)', 
            borderRadius: 'var(--radius-lg)', 
            color: 'var(--text-success)', 
            textAlign: 'center',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '1rem',
            animation: 'fadeIn 0.4s ease'
          }}
        >
          <ShieldCheck size={48} />
          <div>
            <h3 style={{ color: 'var(--text-success)', margin: '0 0 0.25rem 0', fontSize: '1.15rem' }}>Your books are tax-ready!</h3>
            <p style={{ margin: 0, fontSize: '0.875rem', opacity: 0.85 }}>All clear — no open compliance findings detected.</p>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          {(['critical', 'warning', 'info'] as const).map((sev) => {
            const list = (grouped[sev] ?? [])
              .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
            if (list.length === 0) return null;
            return (
              <div key={sev} style={{ animation: 'fadeIn 0.3s ease' }}>
                <div 
                  style={{ 
                    fontSize: '0.725rem', 
                    color: 'var(--text-muted)', 
                    textTransform: 'uppercase', 
                    letterSpacing: '0.075em', 
                    marginBottom: '0.75rem', 
                    fontWeight: 700,
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.35rem'
                  }}
                >
                  <span 
                    style={{ 
                      width: '8px', 
                      height: '8px', 
                      borderRadius: '50%', 
                      background: sev === 'critical' ? 'var(--accent-danger)' : sev === 'warning' ? 'var(--accent-warning)' : 'var(--accent-info)'
                    }} 
                  />
                  {sev} ({list.length})
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                  {list.map((f) => (
                    <FindingRow key={f.id} f={f} onMute={muteFinding} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function FindingRow({ f, onMute }: { f: Finding; onMute: (id: string, muted: boolean) => void }) {
  const isResolved = !!f.resolved_at;
  const isMuted = f.is_muted;

  const severityStyles = {
    critical: {
      border: 'rgba(239, 68, 68, 0.25)',
      badge: 'badge-danger',
      leftBorder: 'var(--accent-danger)'
    },
    warning: {
      border: 'rgba(245, 158, 11, 0.25)',
      badge: 'badge-warning',
      leftBorder: 'var(--accent-warning)'
    },
    info: {
      border: 'rgba(59, 130, 246, 0.25)',
      badge: 'badge-info',
      leftBorder: 'var(--accent-info)'
    }
  }[f.severity];

  return (
    <div 
      className="card"
      style={{
        padding: '1.25rem',
        borderLeft: `4px solid ${isResolved ? 'var(--text-muted)' : severityStyles.leftBorder}`,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
        gap: '1rem',
        opacity: isResolved || isMuted ? 0.6 : 1,
        transition: 'var(--transition-smooth)',
        borderRadius: 'var(--radius-md)'
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div 
          style={{ 
            fontSize: '0.925rem', 
            fontWeight: 700, 
            color: 'var(--text-title)',
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem'
          }}
        >
          {f.title}
          {isResolved && <span className="badge badge-success" style={{ fontSize: '9px', padding: '1px 4px' }}>Resolved</span>}
          {isMuted && <span className="badge badge-neutral" style={{ fontSize: '9px', padding: '1px 4px' }}>Muted</span>}
        </div>
        {f.description && (
          <div style={{ fontSize: '0.825rem', color: 'var(--text-body)', marginTop: '0.35rem', lineHeight: '1.5' }}>
            {f.description}
          </div>
        )}
        <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.5rem', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
          <span>Code: <code>{f.check_code}</code></span>
          {f.resource_type && <span>· Resource: {f.resource_type}</span>}
          <span>· First seen: {new Date(f.first_seen_at).toLocaleDateString('en-AU')}</span>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', flexShrink: 0 }}>
        {f.fix_url && !isResolved && (
          <Link
            to={f.fix_url}
            className="btn btn-primary"
            style={{
              padding: '0.35rem 0.75rem',
              fontSize: '0.75rem',
              whiteSpace: 'nowrap',
              textDecoration: 'none'
            }}
          >
            {f.fix_action ?? 'Resolve'} →
          </Link>
        )}
        {!isResolved && (
          <button
            onClick={() => onMute(f.id, !f.is_muted)}
            className="btn btn-secondary"
            style={{
              padding: '0.25rem 0.5rem',
              fontSize: '0.725rem',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.25rem'
            }}
            title={f.is_muted ? 'Unmute item' : 'Mute item from appearing in future scans'}
          >
            {f.is_muted ? <Eye size={12} /> : <EyeOff size={12} />}
            {f.is_muted ? 'Unmute' : 'Mute'}
          </button>
        )}
      </div>
    </div>
  );
}

function SummaryCard({ 
  label, 
  value, 
  type,
  icon: Icon
}: { 
  label: string; 
  value: number; 
  type: 'critical' | 'warning' | 'info';
  icon: LucideIcon;
}) {
  const colors = {
    critical: {
      text: 'var(--text-danger)',
      border: 'rgba(239, 68, 68, 0.2)',
      bg: 'var(--bg-danger-subtle)',
    },
    warning: {
      text: 'var(--text-warning)',
      border: 'rgba(245, 158, 11, 0.2)',
      bg: 'var(--bg-warning-subtle)',
    },
    info: {
      text: 'var(--text-info)',
      border: 'rgba(59, 130, 246, 0.2)',
      bg: 'var(--bg-info-subtle)',
    }
  }[type];

  return (
    <div 
      className="card"
      style={{ 
        padding: '1.25rem', 
        borderLeft: `4px solid ${type === 'critical' ? 'var(--accent-danger)' : type === 'warning' ? 'var(--accent-warning)' : 'var(--accent-info)'}`,
        position: 'relative'
      }}
    >
      <div 
        style={{ 
          fontSize: '0.675rem', 
          color: 'var(--text-muted)', 
          textTransform: 'uppercase', 
          letterSpacing: '0.05em',
          fontWeight: 700
        }}
      >
        {label}
      </div>
      <div 
        style={{ 
          marginTop: '0.35rem', 
          fontSize: '1.75rem', 
          color: colors.text, 
          fontWeight: 800,
          fontFamily: 'var(--font-title)'
        }}
      >
        <AnimatedNumber value={value} />
      </div>
      <div 
        style={{ 
          position: 'absolute', 
          right: '1rem', 
          bottom: '1rem', 
          color: colors.text,
          opacity: 0.6
        }}
      >
        <Icon size={20} />
      </div>
    </div>
  );
}
