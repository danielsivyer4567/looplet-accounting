import type { CSSProperties } from 'react';
import { useOrg } from '@/hooks/useOrg';
import { useAsic, type AsicFiling } from '@/hooks/useAsic';
import { useRegistrations, type RegistrationLine } from '@/hooks/useRegistrations';
import { SkeletonTable } from '@/components/Skeleton';
import { formatLoadError } from '@/lib/errorMessages';
import { formatMoney } from '@/lib/money';
import {
  AlertTriangle,
  Building2,
  ClipboardCheck,
  Download,
  ExternalLink,
  FileText,
  UserRound,
  Wand2,
} from 'lucide-react';

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

function FilingStatusChip({ status }: { status: AsicFiling['status'] }) {
  const className =
    status === 'accepted'
      ? 'badge badge-success'
      : status === 'rejected'
        ? 'badge badge-danger'
        : status === 'lodged'
          ? 'badge badge-warning'
          : 'badge badge-neutral';
  return (
    <span className={className} style={{ fontSize: '11px', textTransform: 'none' }}>
      {status}
    </span>
  );
}

const formatDate = (value: string | null | undefined): string => {
  if (!value) return '—';
  const isoDate = value.includes('T') ? value.slice(0, 10) : value;
  return new Date(`${isoDate}T00:00:00`).toLocaleDateString('en-AU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
};

function AsicRegisterSection() {
  const {
    officers,
    shares,
    filings,
    isCompany,
    asicReviewDate,
    annualReview,
    directorsMissingId,
    lastDraft,
    loading,
    error,
    actionBusy,
    generateForm484Draft,
  } = useAsic();

  return (
    <section style={{ marginTop: '2.5rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
        <Building2 size={22} style={{ color: 'var(--accent-primary)' }} />
        <h2 style={{ margin: 0, fontSize: '1.25rem' }}>ASIC company register</h2>
      </div>

      {loading ? (
        <SkeletonTable rows={4} cols={4} />
      ) : error ? (
        <div
          className="badge badge-warning"
          style={{ display: 'block', padding: '0.75rem', textTransform: 'none' }}
        >
          ASIC register data is unavailable: {error}
        </div>
      ) : !isCompany ? (
        <div style={noticeCardStyle}>
          ASIC registers are shown when the business profile entity type is company.
        </div>
      ) : (
        <>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              gap: '1rem',
              alignItems: 'flex-start',
              flexWrap: 'wrap',
              marginBottom: '1rem',
            }}
          >
            <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem', lineHeight: 1.7 }}>
              <div>
                Annual review date: <strong>{formatDate(asicReviewDate)}</strong>
              </div>
              <div>
                Calendar reminder:{' '}
                <strong>
                  {annualReview
                    ? `${annualReview.title} — ${formatDate(annualReview.due_date)}`
                    : '—'}
                </strong>
              </div>
            </div>
            <button
              className="btn btn-secondary"
              disabled={actionBusy}
              onClick={() => {
                void generateForm484Draft();
              }}
            >
              <Wand2 size={14} /> {actionBusy ? 'Generating…' : 'Generate Form 484 draft'}
            </button>
          </div>

          {directorsMissingId.length > 0 && (
            <div
              style={{
                display: 'flex',
                gap: '0.5rem',
                alignItems: 'flex-start',
                padding: '0.75rem',
                marginBottom: '1rem',
                border: '1px solid var(--accent-warning)',
                borderRadius: 'var(--radius-sm)',
                color: 'var(--text-title)',
                fontSize: '0.85rem',
              }}
            >
              <AlertTriangle
                size={16}
                style={{ color: 'var(--accent-warning)', flexShrink: 0, marginTop: 2 }}
              />
              <span>
                Director ID missing for {directorsMissingId.map((d) => d.name).join(', ')}.
              </span>
            </div>
          )}

          {lastDraft && (
            <div
              className={
                lastDraft.status === 'empty' ? 'badge badge-neutral' : 'badge badge-success'
              }
              style={{
                display: 'block',
                padding: '0.75rem',
                marginBottom: '1rem',
                textTransform: 'none',
              }}
            >
              {lastDraft.status === 'empty'
                ? 'No Form 484 changes detected.'
                : `Draft Form 484 created with ${lastDraft.change_count} change${lastDraft.change_count === 1 ? '' : 's'}.`}
            </div>
          )}

          <div style={{ display: 'grid', gap: '1.25rem' }}>
            <div>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.4rem',
                  marginBottom: '0.5rem',
                }}
              >
                <UserRound size={16} style={{ color: 'var(--text-muted)' }} />
                <h3 style={{ margin: 0, fontSize: '1rem' }}>Officers</h3>
              </div>
              <div className="table-premium-container">
                <table className="table-premium">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Role</th>
                      <th>Director ID</th>
                      <th>Appointment</th>
                      <th>Cessation</th>
                    </tr>
                  </thead>
                  <tbody>
                    {officers.length === 0 ? (
                      <tr>
                        <td colSpan={5} style={{ color: 'var(--text-muted)' }}>
                          No officers recorded.
                        </td>
                      </tr>
                    ) : (
                      officers.map((officer) => (
                        <tr key={officer.id}>
                          <td style={{ fontWeight: 600, color: 'var(--text-title)' }}>
                            {officer.name}
                          </td>
                          <td>{officer.role}</td>
                          <td>{officer.director_id || '—'}</td>
                          <td>{formatDate(officer.appointment_date)}</td>
                          <td>{formatDate(officer.cessation_date)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div>
              <h3 style={{ margin: '0 0 0.5rem', fontSize: '1rem' }}>Share register</h3>
              <div className="table-premium-container">
                <table className="table-premium">
                  <thead>
                    <tr>
                      <th>Member</th>
                      <th>Class</th>
                      <th>Held</th>
                      <th>Paid</th>
                      <th>Unpaid</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shares.length === 0 ? (
                      <tr>
                        <td colSpan={5} style={{ color: 'var(--text-muted)' }}>
                          No shareholdings recorded.
                        </td>
                      </tr>
                    ) : (
                      shares.map((share) => (
                        <tr key={share.id}>
                          <td style={{ fontWeight: 600, color: 'var(--text-title)' }}>
                            {share.member_name}
                          </td>
                          <td>{share.share_class}</td>
                          <td>{share.number_held.toLocaleString('en-AU')}</td>
                          <td>{formatMoney(share.amount_paid_cents)}</td>
                          <td>{formatMoney(share.amount_unpaid_cents)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.4rem',
                  marginBottom: '0.5rem',
                }}
              >
                <FileText size={16} style={{ color: 'var(--text-muted)' }} />
                <h3 style={{ margin: 0, fontSize: '1rem' }}>ASIC filings</h3>
              </div>
              <div className="table-premium-container">
                <table className="table-premium">
                  <thead>
                    <tr>
                      <th>Form</th>
                      <th>Status</th>
                      <th>Lodgement date</th>
                      <th>Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filings.length === 0 ? (
                      <tr>
                        <td colSpan={4} style={{ color: 'var(--text-muted)' }}>
                          No ASIC filings recorded.
                        </td>
                      </tr>
                    ) : (
                      filings.map((filing) => (
                        <tr key={filing.id}>
                          <td style={{ fontWeight: 600, color: 'var(--text-title)' }}>
                            Form {filing.form_type}
                          </td>
                          <td>
                            <FilingStatusChip status={filing.status} />
                          </td>
                          <td>{formatDate(filing.lodgement_date)}</td>
                          <td>{formatDate(filing.created_at)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </>
      )}
    </section>
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
      <p
        style={{
          color: 'var(--text-muted)',
          fontSize: '0.9rem',
          marginTop: 0,
          marginBottom: '1.5rem',
        }}
      >
        Prepare your ABN, GST, PAYG, and FBT registrations from your business profile. This
        pre-fills the details and links you to the official channel — it does not submit on your
        behalf.
      </p>

      {loading ? (
        <SkeletonTable rows={5} cols={3} />
      ) : error ? (
        <div
          className="badge badge-danger"
          style={{ display: 'block', padding: '0.75rem', textTransform: 'none' }}
        >
          {formatLoadError('business profile', error)}
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
                    <td style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                      {line.reason}
                    </td>
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
            <span>
              Entity type: <strong>{orDash(payload.entity_type)}</strong>
            </span>
            <span>
              State: <strong>{orDash(payload.state_code)}</strong>
            </span>
            <span>
              Industry: <strong>{orDash(payload.industry_label ?? payload.industry_code)}</strong>
            </span>
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

      <AsicRegisterSection />
    </section>
  );
}
