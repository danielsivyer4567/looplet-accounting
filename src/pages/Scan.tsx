import { useState, useEffect, useCallback, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';
import {
  ShieldAlert,
  AlertTriangle,
  Info,
  Play,
  Eye,
  EyeOff,
  ShieldCheck,
  Loader2,
  type LucideIcon,
} from 'lucide-react';
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

// The checks public.run_data_completeness_scan really runs (latest definition in
// supabase/migrations). Keep this list in step with the SQL: ScanHonest.test.tsx compares them.
const SCAN_CHECKS: { code: string; severity: Finding['severity']; label: string }[] = [
  {
    code: 'subbie_without_abn',
    severity: 'critical',
    label: 'Suppliers coded as subcontractors with no ABN recorded',
  },
  { code: 'bill_no_category', severity: 'warning', label: 'Bills with no expense category' },
  {
    code: 'bill_high_value_no_attachment',
    severity: 'warning',
    label: 'Bills over $1,000 not yet attached to a job',
  },
  {
    code: 'bill_gst_mismatch',
    severity: 'warning',
    label: 'Bills over $100 whose GST is more than $2 away from 1/11 of the total',
  },
  {
    code: 'invoice_overdue_60d',
    severity: 'warning',
    label: 'Unpaid invoices more than 60 days past their due date',
  },
  {
    code: 'vehicle_expenses_no_logbook',
    severity: 'warning',
    label: 'Motor vehicle bills when your business profile says there is no logbook',
  },
  {
    code: 'bill_personal_with_business_category',
    severity: 'warning',
    label: 'Bills marked personal that still have a business expense category',
  },
  {
    code: 'subscription_unclassified',
    severity: 'info',
    label: 'Subscriptions not tagged as business or personal',
  },
  {
    code: 'profile_incomplete',
    severity: 'info',
    label: 'Business profile missing entity type, state, turnover bracket or GST/BAS details',
  },
];

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

  const grouped = useMemo<Record<Finding['severity'], Finding[]>>(() => {
    const map: Record<Finding['severity'], Finding[]> = { critical: [], warning: [], info: [] };
    for (const f of findings) (map[f.severity] ??= []).push(f);
    return map;
  }, [findings]);

  if (!currentOrg) return null;

  // One database call that runs the fixed checks in SCAN_CHECKS; nothing else is checked.
  const runScan = async () => {
    setScanning(true);
    setError(null);
    setSummary(null);
    try {
      const { data, error: e } = await supabase.rpc('run_data_completeness_scan', {
        p_org_id: currentOrg.id,
      });
      if (e) {
        setError(e.message);
        return;
      }
      setSummary(data as ScanSummary);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An unexpected error occurred during the scan.');
    } finally {
      setScanning(false);
    }
  };

  const muteFinding = async (id: string, muted: boolean) => {
    const { error: e } = await supabase
      .from('data_completeness_findings')
      .update({ is_muted: muted })
      .eq('id', id);
    if (e) {
      setError(e.message);
      return;
    }
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
  const findingTrendSource = findings
    .slice()
    .sort((a, b) => a.first_seen_at.localeCompare(b.first_seen_at));
  const riskTrendItems = findings.length
    ? findingTrendSource.map((finding) => {
        runningRiskScore +=
          finding.severity === 'critical' ? 3 : finding.severity === 'warning' ? 2 : 1;
        return {
          label: new Date(finding.first_seen_at).toLocaleDateString('en-AU', {
            day: '2-digit',
            month: 'short',
          }),
          value: runningRiskScore,
        };
      })
    : [{ label: 'Clear', value: 0 }];
  const criticalTrendItems = findingTrendSource.map((finding) => {
    if (finding.severity === 'critical') runningCriticalScore += 3;
    return {
      label: new Date(finding.first_seen_at).toLocaleDateString('en-AU', {
        day: '2-digit',
        month: 'short',
      }),
      value: runningCriticalScore,
    };
  });
  const warningTrendItems = findingTrendSource.map((finding) => {
    if (finding.severity === 'warning') runningWarningScore += 2;
    return {
      label: new Date(finding.first_seen_at).toLocaleDateString('en-AU', {
        day: '2-digit',
        month: 'short',
      }),
      value: runningWarningScore,
    };
  });

  return (
    <section className="animated-fade-in" style={{ position: 'relative' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '1rem',
          marginBottom: '1.5rem',
        }}
      >
        <div>
          <h1 style={{ margin: 0 }}>Data checks</h1>
          <p
            style={{
              color: 'var(--text-muted)',
              fontSize: '0.875rem',
              marginTop: '0.35rem',
              marginBottom: 0,
              maxWidth: '640px',
            }}
          >
            Runs {SCAN_CHECKS.length} fixed checks on the data in your books and lists what needs
            fixing. It is not an audit and does not check every tax rule.
          </p>
        </div>

        <button
          onClick={() => void runScan()}
          disabled={scanning}
          className="btn btn-primary"
          aria-busy={scanning}
        >
          {scanning ? <Loader2 size={14} className="spin" /> : <Play size={14} />}
          {scanning ? 'Running checks…' : 'Run checks now'}
        </button>
      </div>

      <section
        className="card"
        aria-labelledby="scan-checks-heading"
        style={{ padding: '1rem 1.25rem', marginBottom: '1.5rem' }}
      >
        <h2 id="scan-checks-heading" style={{ margin: '0 0 0.5rem', fontSize: '1rem' }}>
          What these checks look at
        </h2>
        <ul
          style={{
            margin: 0,
            paddingLeft: '1.1rem',
            display: 'grid',
            gap: '0.3rem',
            fontSize: '0.825rem',
            color: 'var(--text-body)',
          }}
        >
          {SCAN_CHECKS.map((check) => (
            <li key={check.code} data-check-code={check.code}>
              {check.label}{' '}
              <span style={{ color: 'var(--text-muted)' }}>({check.severity})</span>
            </li>
          ))}
        </ul>
      </section>

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
            tone={
              grouped.critical.length > 0
                ? 'danger'
                : grouped.warning.length > 0
                  ? 'warning'
                  : 'success'
            }
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
                  ? 'Fix before relying on these figures'
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
            lineHeight: '1.4',
          }}
        >
          Last run: {summary.critical} critical, {summary.warning} warnings,{' '}
          {summary.info} info · {summary.resolved_this_run} auto-resolved · ran{' '}
          {new Date(summary.scanned_at).toLocaleString('en-AU')}
        </div>
      )}

      {/* Severity Counters Grid */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          gap: '1rem',
          marginBottom: '1.5rem',
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
          alignItems: 'center',
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
        <div
          className="badge badge-danger"
          style={{
            display: 'block',
            padding: '0.75rem',
            marginBottom: '1.5rem',
            textTransform: 'none',
          }}
        >
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
            animation: 'fadeIn 0.4s ease',
          }}
        >
          <ShieldCheck size={48} />
          <div>
            <h3
              style={{ color: 'var(--text-success)', margin: '0 0 0.25rem 0', fontSize: '1.15rem' }}
            >
              No open findings from these checks
            </h3>
            <p style={{ margin: 0, fontSize: '0.875rem', opacity: 0.85 }}>
              That covers only the {SCAN_CHECKS.length} checks listed above. It is not a full tax
              review.
            </p>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          {(['critical', 'warning', 'info'] as const).map((sev) => {
            const list = (grouped[sev] ?? []).sort(
              (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
            );
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
                    gap: '0.35rem',
                  }}
                >
                  <span
                    style={{
                      width: '8px',
                      height: '8px',
                      borderRadius: '50%',
                      background:
                        sev === 'critical'
                          ? 'var(--accent-danger)'
                          : sev === 'warning'
                            ? 'var(--accent-warning)'
                            : 'var(--accent-info)',
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
      border: 'var(--border-danger)',
      badge: 'badge-danger',
      leftBorder: 'var(--accent-danger)',
    },
    warning: {
      border: 'var(--border-warning)',
      badge: 'badge-warning',
      leftBorder: 'var(--accent-warning)',
    },
    info: {
      border: 'var(--border-info)',
      badge: 'badge-info',
      leftBorder: 'var(--accent-info)',
    },
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
        borderRadius: 'var(--radius-md)',
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
            gap: '0.5rem',
          }}
        >
          {f.title}
          {isResolved && (
            <span className="badge badge-success" style={{ fontSize: '9px', padding: '1px 4px' }}>
              Resolved
            </span>
          )}
          {isMuted && (
            <span className="badge badge-neutral" style={{ fontSize: '9px', padding: '1px 4px' }}>
              Muted
            </span>
          )}
        </div>
        {f.description && (
          <div
            style={{
              fontSize: '0.825rem',
              color: 'var(--text-body)',
              marginTop: '0.35rem',
              lineHeight: '1.5',
            }}
          >
            {f.description}
          </div>
        )}
        <div
          style={{
            display: 'flex',
            gap: '0.75rem',
            marginTop: '0.5rem',
            fontSize: '0.75rem',
            color: 'var(--text-muted)',
          }}
        >
          <span>
            Code: <code>{f.check_code}</code>
          </span>
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
              textDecoration: 'none',
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
              gap: '0.25rem',
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
  icon: Icon,
}: {
  label: string;
  value: number;
  type: 'critical' | 'warning' | 'info';
  icon: LucideIcon;
}) {
  const colors = {
    critical: {
      text: 'var(--text-danger)',
      border: 'var(--border-danger)',
      bg: 'var(--bg-danger-subtle)',
    },
    warning: {
      text: 'var(--text-warning)',
      border: 'var(--border-warning)',
      bg: 'var(--bg-warning-subtle)',
    },
    info: {
      text: 'var(--text-info)',
      border: 'var(--border-info)',
      bg: 'var(--bg-info-subtle)',
    },
  }[type];

  return (
    <div
      className="card"
      style={{
        padding: '1.25rem',
        borderLeft: `4px solid ${type === 'critical' ? 'var(--accent-danger)' : type === 'warning' ? 'var(--accent-warning)' : 'var(--accent-info)'}`,
        position: 'relative',
      }}
    >
      <div
        style={{
          fontSize: '0.675rem',
          color: 'var(--text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          fontWeight: 700,
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
          fontFamily: 'var(--font-title)',
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
          opacity: 0.6,
        }}
      >
        <Icon size={20} />
      </div>
    </div>
  );
}
