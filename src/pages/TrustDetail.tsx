import { useMemo, useState, type CSSProperties } from 'react';
import { Link, useParams } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';
import { useTrust, BENEFICIARY_TYPES } from '@/hooks/useTrusts';
import { useTrustDistribution } from '@/hooks/useTrustDistribution';
import { useDiv7a, type Div7aBreach } from '@/hooks/useDiv7a';
import { SkeletonTable } from '@/components/Skeleton';
import { titleCase, formatDay, currentFyStartYear } from '@/lib/formatting';
import { formatMoney } from '@/lib/money';
import { downloadBlob } from '@/lib/download';
import {
  ChevronLeft,
  Landmark,
  FileText,
  Plus,
  Save,
  Edit3,
  Trash2,
  Coins,
  AlertTriangle,
  Banknote,
} from 'lucide-react';
import { PageHeader } from '@/components/ui/PageHeader';

const cardStyle: CSSProperties = {
  background: 'var(--bg-card)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-md)',
  padding: '1.25rem 1.5rem',
  marginBottom: '1.5rem',
};

const sectionTitleStyle: CSSProperties = {
  fontSize: '0.725rem',
  color: 'var(--text-muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  marginBottom: '1rem',
  fontWeight: 700,
  display: 'flex',
  alignItems: 'center',
  gap: '0.4rem',
};

// Icon + label button content alignment, shared by the action buttons.
const btnIconStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.25rem',
};

// A blank beneficiary draft for the add form.
const EMPTY_BENEFICIARY = {
  name: '',
  beneficiary_type: 'individual',
  relationship: '',
  abn: '',
  date_of_birth: '',
};

export function TrustDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { currentOrg } = useOrg();
  const { trust, deed, beneficiaries, loading, error, refresh } = useTrust(id);

  // Beneficiary add/edit state.
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<typeof EMPTY_BENEFICIARY>(EMPTY_BENEFICIARY);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<typeof EMPTY_BENEFICIARY>(EMPTY_BENEFICIARY);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  if (!currentOrg) return null;

  // Normalise a draft into the columns trust_beneficiaries expects (empty -> null;
  // date_of_birth only valid for an individual, per the table CHECK).
  const toPayload = (d: Partial<typeof EMPTY_BENEFICIARY>) => {
    const type = (d.beneficiary_type ?? 'individual').trim();
    return {
      name: (d.name ?? '').trim(),
      beneficiary_type: type,
      relationship: d.relationship?.toString().trim() || null,
      abn: d.abn?.toString().trim() || null,
      date_of_birth: type === 'individual' ? d.date_of_birth?.toString().trim() || null : null,
    };
  };

  const addBeneficiary = async () => {
    if (!id || !draft.name.trim()) {
      setFormError('Name is required.');
      return;
    }
    setSaving(true);
    setFormError(null);
    const { error: insErr } = await supabase
      .from('trust_beneficiaries')
      .insert({ organization_id: currentOrg.id, trust_id: id, ...toPayload(draft) });
    setSaving(false);
    if (insErr) {
      setFormError(insErr.message);
      return;
    }
    setAdding(false);
    setDraft(EMPTY_BENEFICIARY);
    void refresh();
  };

  const saveEdit = async (benId: string) => {
    setSaving(true);
    setFormError(null);
    const { error: updErr } = await supabase
      .from('trust_beneficiaries')
      .update(toPayload(editDraft))
      .eq('id', benId);
    setSaving(false);
    if (updErr) {
      setFormError(updErr.message);
      return;
    }
    setEditingId(null);
    void refresh();
  };

  const removeBeneficiary = async (benId: string, benName: string) => {
    // Destructive — confirm first (mirrors the app's archive-with-confirmation norm).
    if (!window.confirm(`Remove beneficiary "${benName}"? It will be hidden from this trust.`)) {
      return;
    }
    setSaving(true);
    // Soft-delete (house convention) — set deleted_at rather than hard delete.
    const { error: delErr } = await supabase
      .from('trust_beneficiaries')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', benId);
    setSaving(false);
    if (delErr) {
      setFormError(delErr.message);
      return;
    }
    void refresh();
  };

  const openDeed = async () => {
    if (!deed?.storage_key) return;
    const { data, error: urlErr } = await supabase.storage
      .from('bills')
      .createSignedUrl(deed.storage_key, 60 * 10);
    if (urlErr || !data) {
      setFormError(urlErr?.message ?? 'Could not open the deed document.');
      return;
    }
    window.open(data.signedUrl, '_blank', 'noopener,noreferrer');
  };

  return (
    <section className="animated-fade-in">
      <Link
        to="/trusts"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: '0.25rem',
          color: 'var(--text-muted)',
          marginBottom: '1rem',
        }}
      >
        <ChevronLeft size={16} /> Trusts
      </Link>

      {loading ? (
        <SkeletonTable rows={4} cols={3} />
      ) : error || !trust ? (
        <div
          className="badge badge-danger"
          style={{ display: 'block', padding: '0.75rem', textTransform: 'none' }}
        >
          {error ?? 'Trust not found.'}
        </div>
      ) : (
        <>
          <PageHeader
            title={
              <>
                <Landmark size={24} style={{ color: 'var(--text-link)' }} /> {trust.name}{' '}
                <span
                  className="badge badge-neutral"
                  style={{ fontSize: '11px', textTransform: 'none' }}
                >
                  {' '}
                  {titleCase(trust.trust_type)}{' '}
                </span>
              </>
            }
            style={{ margin: '0 0 1.5rem' }}
          />

          {/* Trust summary */}
          <div style={cardStyle}>
            <div style={sectionTitleStyle}>
              <Landmark size={14} style={{ color: 'var(--text-link)' }} /> Trust
            </div>
            <dl
              style={{
                display: 'grid',
                gridTemplateColumns: 'auto 1fr',
                gap: '0.5rem 1.5rem',
                margin: 0,
              }}
            >
              <dt style={{ color: 'var(--text-muted)' }}>Trustee</dt>
              <dd style={{ margin: 0 }}>
                {trust.trustee_name ?? '—'}
                {trust.is_corporate_trustee ? ' (corporate)' : ''}
                {trust.trustee_abn ? (
                  <>
                    {' '}
                    · <code>{trust.trustee_abn}</code>
                  </>
                ) : null}
              </dd>
              <dt style={{ color: 'var(--text-muted)' }}>ABN</dt>
              <dd style={{ margin: 0 }}>{trust.abn ? <code>{trust.abn}</code> : '—'}</dd>
              <dt style={{ color: 'var(--text-muted)' }}>Settled</dt>
              <dd style={{ margin: 0 }}>{formatDay(trust.settled_date)}</dd>
            </dl>
          </div>

          {/* Deed */}
          <div style={cardStyle}>
            <div style={sectionTitleStyle}>
              <FileText size={14} style={{ color: 'var(--text-link)' }} /> Deed
            </div>
            {deed ? (
              <dl
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'auto 1fr',
                  gap: '0.5rem 1.5rem',
                  margin: 0,
                }}
              >
                <dt style={{ color: 'var(--text-muted)' }}>Deed date</dt>
                <dd style={{ margin: 0 }}>{formatDay(deed.deed_date)}</dd>
                <dt style={{ color: 'var(--text-muted)' }}>Vesting date</dt>
                <dd style={{ margin: 0 }}>{formatDay(deed.vesting_date)}</dd>
                <dt style={{ color: 'var(--text-muted)' }}>Streaming allowed</dt>
                <dd style={{ margin: 0 }}>{deed.streaming_allowed ? 'Yes' : 'No'}</dd>
                <dt style={{ color: 'var(--text-muted)' }}>Parsed terms</dt>
                <dd style={{ margin: 0 }}>
                  {deed.parsed_terms && Object.keys(deed.parsed_terms).length > 0 ? (
                    <pre
                      style={{
                        margin: 0,
                        fontSize: '0.8rem',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                      }}
                    >
                      {JSON.stringify(deed.parsed_terms, null, 2)}
                    </pre>
                  ) : (
                    <span style={{ color: 'var(--text-muted)' }}>None recorded</span>
                  )}
                </dd>
                <dt style={{ color: 'var(--text-muted)' }}>Document</dt>
                <dd style={{ margin: 0 }}>
                  {deed.storage_key ? (
                    <button className="btn btn-secondary btn-sm" onClick={openDeed}>
                      Open deed PDF
                    </button>
                  ) : (
                    <span style={{ color: 'var(--text-muted)' }}>No document uploaded</span>
                  )}
                </dd>
              </dl>
            ) : (
              <span style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
                No deed recorded for this trust yet.
              </span>
            )}
          </div>

          {/* Beneficiaries */}
          <div style={cardStyle}>
            <div style={{ ...sectionTitleStyle, justifyContent: 'space-between' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <Landmark size={14} style={{ color: 'var(--text-link)' }} /> Beneficiaries
                <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>
                  ({beneficiaries.length})
                </span>
              </span>
              {!adding && (
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => {
                    setAdding(true);
                    setDraft(EMPTY_BENEFICIARY);
                    setFormError(null);
                  }}
                  style={btnIconStyle}
                >
                  <Plus size={14} /> Add
                </button>
              )}
            </div>

            {formError && (
              <div
                className="badge badge-danger"
                style={{
                  display: 'block',
                  padding: '0.5rem',
                  marginBottom: '0.75rem',
                  textTransform: 'none',
                }}
              >
                {formError}
              </div>
            )}

            {adding && (
              <BeneficiaryForm
                draft={draft}
                onChange={setDraft}
                onSave={addBeneficiary}
                onCancel={() => setAdding(false)}
                saving={saving}
              />
            )}

            {beneficiaries.length === 0 && !adding ? (
              <span style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
                No beneficiaries yet.
              </span>
            ) : (
              <div className="table-premium-container">
                <table className="table-premium">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Type</th>
                      <th>Relationship</th>
                      <th>ABN</th>
                      <th>DOB</th>
                      <th style={{ textAlign: 'right' }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {beneficiaries.map((b) =>
                      editingId === b.id ? (
                        <tr key={b.id}>
                          <td colSpan={6}>
                            <BeneficiaryForm
                              draft={editDraft}
                              onChange={setEditDraft}
                              onSave={() => saveEdit(b.id)}
                              onCancel={() => setEditingId(null)}
                              saving={saving}
                            />
                          </td>
                        </tr>
                      ) : (
                        <tr key={b.id}>
                          <td style={{ fontWeight: 600, color: 'var(--text-title)' }}>{b.name}</td>
                          <td>
                            <span
                              className="badge badge-neutral"
                              style={{ fontSize: '11px', textTransform: 'none' }}
                            >
                              {titleCase(b.beneficiary_type)}
                            </span>
                          </td>
                          <td>
                            {b.relationship ? (
                              titleCase(b.relationship)
                            ) : (
                              <span style={{ color: 'var(--text-muted)' }}>—</span>
                            )}
                          </td>
                          <td>
                            {b.abn ? (
                              <code>{b.abn}</code>
                            ) : (
                              <span style={{ color: 'var(--text-muted)' }}>—</span>
                            )}
                          </td>
                          <td>{formatDay(b.date_of_birth)}</td>
                          <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                            <button
                              className="btn btn-ghost btn-sm"
                              title="Edit"
                              onClick={() => {
                                setEditingId(b.id);
                                setEditDraft({
                                  name: b.name,
                                  beneficiary_type: b.beneficiary_type,
                                  relationship: b.relationship ?? '',
                                  abn: b.abn ?? '',
                                  date_of_birth: b.date_of_birth ?? '',
                                });
                                setFormError(null);
                              }}
                            >
                              <Edit3 size={14} />
                            </button>
                            <button
                              className="btn btn-ghost btn-sm"
                              title="Remove"
                              disabled={saving}
                              onClick={() => void removeBeneficiary(b.id, b.name)}
                            >
                              <Trash2 size={14} />
                            </button>
                          </td>
                        </tr>
                      ),
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Distribution wizard */}
          {id && <DistributionWizard trustId={id} />}

          {/* Division 7A tracker (org-wide loans + UPE breach flags) */}
          <Div7aPanel />
        </>
      )}
    </section>
  );
}

// The Division 7A tracker: the org's complying loans (with a generate-agreement action)
// and the breach flags from div7a_breach_scan (repayment shortfalls, over-term loans,
// stale UPEs). Org-wide — Div 7A loans are company->shareholder, not trust-scoped — shown
// in the trust workspace as its Div 7A view.
function Div7aPanel() {
  const { loans, scan, loading, error, agreementBusyId, generateAgreement } = useDiv7a();

  // Group breaches by loan_id for inline flags; stale-UPE breaches are listed separately.
  const { breachesByLoan, upeBreaches } = useMemo(() => {
    const byLoan = new Map<string, Div7aBreach[]>();
    const upes: Div7aBreach[] = [];
    for (const b of scan?.breaches ?? []) {
      if (b.kind === 'stale_upe') {
        upes.push(b);
      } else if (b.loan_id) {
        const list = byLoan.get(b.loan_id) ?? [];
        list.push(b);
        byLoan.set(b.loan_id, list);
      }
    }
    return { breachesByLoan: byLoan, upeBreaches: upes };
  }, [scan?.breaches]);

  return (
    <div style={cardStyle}>
      <div style={{ ...sectionTitleStyle, justifyContent: 'space-between' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          <Banknote size={14} style={{ color: 'var(--text-link)' }} /> Division 7A
        </span>
        {scan && (
          <span
            style={{
              fontWeight: 400,
              color: scan.breach_count > 0 ? 'var(--text-danger)' : 'var(--text-success)',
            }}
          >
            {scan.breach_count > 0
              ? `${scan.breach_count} issue${scan.breach_count === 1 ? '' : 's'}`
              : 'No issues'}
          </span>
        )}
      </div>

      {error && (
        <div
          className="badge badge-danger"
          style={{
            display: 'block',
            padding: '0.5rem',
            marginBottom: '0.75rem',
            textTransform: 'none',
          }}
        >
          {error}
        </div>
      )}

      {loading ? (
        <SkeletonTable rows={3} cols={4} />
      ) : loans.length === 0 ? (
        <span style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
          No Division 7A loans recorded.
        </span>
      ) : (
        <div className="table-premium-container">
          <table className="table-premium">
            <thead>
              <tr>
                <th>Lender → Borrower</th>
                <th>Made</th>
                <th style={{ textAlign: 'right' }}>Principal</th>
                <th>Term</th>
                <th>Status</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loans.map((l) => {
                const flags = breachesByLoan.get(l.id) ?? [];
                const hasShortfall = flags.some((f) => f.kind === 'repayment_shortfall');
                return (
                  <tr key={l.id}>
                    <td style={{ fontWeight: 600, color: 'var(--text-title)' }}>
                      {l.lender_company_name} → {l.borrower_name}
                    </td>
                    <td>
                      FY{l.loan_year}-{l.loan_year + 1}
                    </td>
                    <td style={{ textAlign: 'right' }}>{formatMoney(l.principal_cents)}</td>
                    <td>{l.term_years}yr</td>
                    <td>
                      {flags.length > 0 ? (
                        <span
                          className="badge badge-danger"
                          style={{
                            fontSize: '11px',
                            textTransform: 'none',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '0.25rem',
                          }}
                          title={flags.map((f) => f.detail ?? f.kind).join('\n')}
                        >
                          <AlertTriangle size={12} />
                          {hasShortfall ? 'Shortfall' : 'Over term'}
                        </span>
                      ) : l.has_complying_agreement ? (
                        <span
                          className="badge badge-success"
                          style={{ fontSize: '11px', textTransform: 'none' }}
                        >
                          Complying
                        </span>
                      ) : (
                        <span
                          className="badge badge-neutral"
                          style={{ fontSize: '11px', textTransform: 'none' }}
                        >
                          No agreement
                        </span>
                      )}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <button
                        className="btn btn-secondary btn-sm"
                        disabled={agreementBusyId === l.id}
                        onClick={() => void generateAgreement(l.id)}
                        style={btnIconStyle}
                      >
                        <FileText size={14} />{' '}
                        {agreementBusyId === l.id ? 'Generating…' : 'Agreement'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Stale UPEs (not tied to a loan row) */}
      {upeBreaches.length > 0 && (
        <div style={{ marginTop: '1rem' }}>
          <div
            style={{
              fontSize: '0.8rem',
              color: 'var(--text-danger)',
              fontWeight: 600,
              marginBottom: '0.4rem',
              display: 'flex',
              alignItems: 'center',
              gap: '0.25rem',
            }}
          >
            <AlertTriangle size={13} /> Unpaid present entitlements at risk
          </div>
          <ul
            style={{
              margin: 0,
              paddingLeft: '1.1rem',
              fontSize: '0.85rem',
              color: 'var(--text-body)',
            }}
          >
            {upeBreaches.map((u) => (
              <li key={u.upe_id}>
                {u.beneficiary} — {formatMoney(u.unpaid_amount_cents)} unpaid from FY{u.year_arose}-
                {(u.year_arose ?? 0) + 1}, still unmanaged
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// The distribution wizard: pick an income year, run the streaming optimiser proposal,
// review the per-beneficiary streamed components, save it as draft, generate the minute,
// and (once an approval exists) finalise. Approve itself lives in the approvals queue
// (SC-2.E) — we link out rather than re-implement it here.
function DistributionWizard({ trustId }: { trustId: string }) {
  const { proposal, loading, error, persisting, persistResult, runProposal, persistDraft } =
    useTrustDistribution();
  const [fy, setFy] = useState<number>(currentFyStartYear());
  const [minuteBusy, setMinuteBusy] = useState(false);
  const [minuteError, setMinuteError] = useState<string | null>(null);

  // Generate the distribution minute PDF (trust-minute edge fn, SC-5.D.01) and download it.
  const generateMinute = async () => {
    setMinuteBusy(true);
    setMinuteError(null);
    const { data, error: fnErr } = await supabase.functions.invoke<Blob>('trust-minute', {
      body: { trust_id: trustId, fy_start_year: fy },
    });
    setMinuteBusy(false);
    if (fnErr || !data) {
      setMinuteError(fnErr?.message ?? 'Could not generate the minute.');
      return;
    }
    downloadBlob(data, `trust-minute-FY${fy}.pdf`);
  };

  const t = proposal?.totals;

  return (
    <div style={cardStyle}>
      <div style={{ ...sectionTitleStyle, justifyContent: 'space-between' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          <Coins size={14} style={{ color: 'var(--text-link)' }} /> Distribution
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontWeight: 400 }}>
          <label style={{ color: 'var(--text-muted)' }}>
            FY
            <input
              className="input"
              type="number"
              value={fy}
              onChange={(e) => setFy(Number(e.target.value))}
              style={{ width: 90, marginLeft: '0.4rem' }}
            />
          </label>
          <button
            className="btn btn-primary btn-sm"
            disabled={loading}
            onClick={() => void runProposal(trustId, fy)}
          >
            {loading ? 'Optimising…' : 'Run proposal'}
          </button>
        </span>
      </div>

      {error && (
        <div
          className="badge badge-danger"
          style={{
            display: 'block',
            padding: '0.5rem',
            marginBottom: '0.75rem',
            textTransform: 'none',
          }}
        >
          {error}
        </div>
      )}

      {!proposal && !loading && !error && (
        <span style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>
          Run the optimiser to propose how FY{fy}-{fy + 1} net income is distributed across
          beneficiaries.
        </span>
      )}

      {proposal && (
        <>
          <div style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
            {proposal.method === 'specific_streaming'
              ? 'Streaming allowed'
              : 'Proportional (no streaming)'}{' '}
            · net income {formatMoney(proposal.net_income_cents)}
            {t && t.trustee_retained_cents > 0 ? (
              <> · trustee retained {formatMoney(t.trustee_retained_cents)}</>
            ) : null}
          </div>
          <div className="table-premium-container">
            <table className="table-premium">
              <thead>
                <tr>
                  <th>Beneficiary</th>
                  <th style={{ textAlign: 'right' }}>Capital gain</th>
                  <th style={{ textAlign: 'right' }}>Franked</th>
                  <th style={{ textAlign: 'right' }}>Credits</th>
                  <th style={{ textAlign: 'right' }}>Other</th>
                  <th style={{ textAlign: 'right' }}>Total</th>
                </tr>
              </thead>
              <tbody>
                {proposal.streamed.map((s) => (
                  <tr key={s.beneficiary_id}>
                    <td style={{ fontWeight: 600, color: 'var(--text-title)' }}>
                      {s.name}
                      {!s.eligible && s.exclusion_reason ? (
                        <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>
                          {' '}
                          · {s.exclusion_reason}
                        </span>
                      ) : null}
                    </td>
                    <td style={{ textAlign: 'right' }}>{formatMoney(s.capital_gain_cents)}</td>
                    <td style={{ textAlign: 'right' }}>{formatMoney(s.franked_dividend_cents)}</td>
                    <td style={{ textAlign: 'right' }}>{formatMoney(s.franking_credits_cents)}</td>
                    <td style={{ textAlign: 'right' }}>{formatMoney(s.other_cents)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>
                      {formatMoney(s.amount_cents)}
                    </td>
                  </tr>
                ))}
              </tbody>
              {t && (
                <tfoot>
                  <tr style={{ fontWeight: 600 }}>
                    <td>Total distributed</td>
                    <td style={{ textAlign: 'right' }}>
                      {formatMoney(t.streamed_capital_gain_cents)}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {formatMoney(t.streamed_franked_dividend_cents)}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {formatMoney(t.streamed_franking_credits_cents)}
                    </td>
                    <td style={{ textAlign: 'right' }}>{formatMoney(t.other_cents)}</td>
                    <td style={{ textAlign: 'right' }}>
                      {formatMoney(t.distributed_amount_cents)}
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>

          {/* Actions */}
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: '0.5rem',
              marginTop: '1rem',
              alignItems: 'center',
            }}
          >
            <button
              className="btn btn-secondary btn-sm"
              disabled={persisting}
              onClick={() => void persistDraft(trustId, fy)}
              style={btnIconStyle}
            >
              <Save size={14} /> {persisting ? 'Saving…' : 'Save draft'}
            </button>
            <button
              className="btn btn-secondary btn-sm"
              disabled={minuteBusy}
              onClick={() => void generateMinute()}
              style={btnIconStyle}
            >
              <FileText size={14} /> {minuteBusy ? 'Generating…' : 'Generate minute'}
            </button>
            {/* Finalise is gated on an approval; approve itself lives in the approvals queue. */}
            <button
              className="btn btn-ghost btn-sm"
              disabled
              title="Requires a Tier-2 approval (see Approvals)"
            >
              Finalise (needs approval)
            </button>
            <Link to="/approvals" style={{ fontSize: '0.85rem', color: 'var(--text-link)' }}>
              Go to Approvals →
            </Link>
          </div>

          {persistResult?.ok && (
            <div style={{ marginTop: '0.6rem', fontSize: '0.85rem', color: 'var(--text-success)' }}>
              Saved {persistResult.drafts_written} draft row
              {persistResult.drafts_written === 1 ? '' : 's'}
              {persistResult.drafts_replaced > 0
                ? ` (replaced ${persistResult.drafts_replaced})`
                : ''}
              .
            </div>
          )}
          {minuteError && (
            <div
              className="badge badge-danger"
              style={{
                display: 'block',
                padding: '0.5rem',
                marginTop: '0.6rem',
                textTransform: 'none',
              }}
            >
              {minuteError}
            </div>
          )}
          {proposal.totals && !proposal.totals.grossed_reconciles && (
            <div style={{ marginTop: '0.6rem', fontSize: '0.8rem', color: 'var(--text-muted)' }}>
              Note: the streamed classes do not fully reconcile to net income (e.g. a current-year
              loss or deduction-heavy year) — review before finalising.
            </div>
          )}
        </>
      )}
    </div>
  );
}

// Inline add/edit form for a beneficiary, shared by the add row and the edit row.
function BeneficiaryForm({
  draft,
  onChange,
  onSave,
  onCancel,
  saving,
}: {
  draft: typeof EMPTY_BENEFICIARY;
  onChange: (d: typeof EMPTY_BENEFICIARY) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
}) {
  const isIndividual = draft.beneficiary_type === 'individual';
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '0.5rem',
        alignItems: 'center',
        padding: '0.75rem',
        background: 'var(--bg-subtle, var(--bg-card))',
        borderRadius: 'var(--radius-sm)',
        marginBottom: '0.75rem',
      }}
    >
      <input
        className="input"
        placeholder="Name"
        value={draft.name}
        onChange={(e) => onChange({ ...draft, name: e.target.value })}
        style={{ minWidth: 160 }}
      />
      <select
        className="input"
        value={draft.beneficiary_type}
        onChange={(e) => onChange({ ...draft, beneficiary_type: e.target.value })}
      >
        {BENEFICIARY_TYPES.map((t) => (
          <option key={t} value={t}>
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </option>
        ))}
      </select>
      <input
        className="input"
        placeholder="Relationship"
        value={draft.relationship}
        onChange={(e) => onChange({ ...draft, relationship: e.target.value })}
        style={{ minWidth: 120 }}
      />
      <input
        className="input"
        placeholder="ABN"
        value={draft.abn}
        onChange={(e) => onChange({ ...draft, abn: e.target.value })}
        style={{ minWidth: 120 }}
      />
      {isIndividual && (
        <input
          className="input"
          type="date"
          title="Date of birth"
          value={draft.date_of_birth}
          onChange={(e) => onChange({ ...draft, date_of_birth: e.target.value })}
        />
      )}
      <button
        className="btn btn-primary btn-sm"
        disabled={saving}
        onClick={onSave}
        style={btnIconStyle}
      >
        <Save size={14} /> {saving ? 'Saving…' : 'Save'}
      </button>
      <button className="btn btn-ghost btn-sm" disabled={saving} onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}
