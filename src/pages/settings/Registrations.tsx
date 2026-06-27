import type { CSSProperties } from 'react';
import { useOrg } from '@/hooks/useOrg';
import { useRegistrations, type RegistrationLine } from '@/hooks/useRegistrations';
import { SkeletonTable } from '@/components/Skeleton';
import { formatMoney } from '@/lib/money';
import { ClipboardCheck, ExternalLink, Download } from 'lucide-react';

// Display a possibly-null field, formatting it when present (— when absent).
const orDash = (value: unknown, format?: (v: never) => string): string =>
  value == null ? '—' : format ? format(value as never) : String(value);

// Dashed notice card (no-profile / empty states), matching the Trusts/SMSF workspace idiom.
const noticeCardStyle: CSSProperties = {
  padding: '2.5rem',
  background: 'var(--bg-card)',
  border: '1px dashed var(--border-subtle)',
  borderRadius: 'var(--radius-md)',
  color: 'var(--text-muted)',
  textAlign: 'center',
  fontSize: '0.9rem',
};

/** The status chip for one registration line: registered / recommended / not needed. */
function StatusChip({ line }: { line: RegistrationLine }) {
  if (line.registered) {
    return (
      <span className="badge badge-success" style={{ fontSize: '11px', textTransform: 'none' }}>
        Registered
      </span>
    );
  }
  if (line.recommended) {
    return (
      <span className="badge badge-warning" style={{ fontSize: '11px', textTransform: 'none' }}>
        Action suggested
      </span>
    );
  }
  return (
    <span className="badge badge-neutral" style={{ fontSize: '11px', textTransform: 'none' }}>
      Not required
    </span>
  );
}

export function RegistrationsPage() {
  const { currentOrg } = useOrg();
  const { payload, loading, error, downloadPayload, abrRegisterUrl } = useRegistrations();

  if (!currentOrg) return null;

  return (
    <section className="animated-fade-in">
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
        <ClipboardCheck size={24} style={{ color: 'var(--accent-primary)' }} />
        <h1 style={{ margin: 0 }}>Registrations</h1>
      </div>
      <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', marginTop: 0, marginBottom: '1.5rem' }}>
        Prepare your ABN, GST, PAYG, and FBT registrations from your business profile. This pre-fills
        the details and links you to the official channel — it does not submit on your behalf.
      </p>

      {loading ? (
        <SkeletonTable rows={5} cols={3} />
      ) : error ? (
        <div
          className="badge badge-danger"
          style={{ display: 'block', padding: '0.75rem', textTransform: 'none' }}
        >
          Failed to load your business profile: {error}
        </div>
      ) : !payload ? (
        <div style={noticeCardStyle}>No business profile found for {currentOrg.name} yet.</div>
      ) : (
        <>
          <div className="table-premium-container">
            <table className="table-premium">
              <thead>
                <tr>
                  <th>Registration</th>
                  <th>Status</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {payload.lines.map((line) => (
                  <tr key={line.type}>
                    <td style={{ fontWeight: 600, color: 'var(--text-title)' }}>{line.label}</td>
                    <td>
                      <StatusChip line={line} />
                    </td>
                    <td style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>{line.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* The pre-filled details carried into the registration. */}
          <div
            style={{
              marginTop: '1.25rem',
              display: 'flex',
              gap: '1.5rem',
              flexWrap: 'wrap',
              fontSize: '0.85rem',
              color: 'var(--text-muted)',
            }}
          >
            <span>Entity type: <strong>{orDash(payload.entity_type)}</strong></span>
            <span>State: <strong>{orDash(payload.state_code)}</strong></span>
            <span>Industry: <strong>{orDash(payload.industry_label ?? payload.industry_code)}</strong></span>
            <span>
              Estimated turnover:{' '}
              <strong>{orDash(payload.estimated_annual_turnover_cents, formatMoney)}</strong>
            </span>
          </div>

          {/* Actions: download the pre-filled payload + open the official ABR channel. */}
          <div style={{ marginTop: '1.5rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button className="btn btn-secondary" onClick={downloadPayload}>
              <Download size={14} /> Download details
            </button>
            <a
              className="btn btn-primary"
              href={abrRegisterUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}
            >
              <ExternalLink size={14} /> Register at the ABR
            </a>
          </div>
        </>
      )}
    </section>
  );
}
