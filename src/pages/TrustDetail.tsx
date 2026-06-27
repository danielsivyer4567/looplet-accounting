import { useState, type CSSProperties } from 'react';
import { Link, useParams } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';
import { useTrust, BENEFICIARY_TYPES } from '@/hooks/useTrusts';
import { SkeletonTable } from '@/components/Skeleton';
import { titleCase, formatDay } from '@/lib/formatting';
import { ChevronLeft, Landmark, FileText, Plus, Save, Edit3, Trash2 } from 'lucide-react';

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
        style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', color: 'var(--text-muted)', marginBottom: '1rem' }}
      >
        <ChevronLeft size={16} /> Trusts
      </Link>

      {loading ? (
        <SkeletonTable rows={4} cols={3} />
      ) : error || !trust ? (
        <div className="badge badge-danger" style={{ display: 'block', padding: '0.75rem', textTransform: 'none' }}>
          {error ?? 'Trust not found.'}
        </div>
      ) : (
        <>
          <h1 style={{ margin: '0 0 1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Landmark size={24} style={{ color: 'var(--accent-primary)' }} />
            {trust.name}
            <span className="badge badge-neutral" style={{ fontSize: '11px', textTransform: 'none' }}>
              {titleCase(trust.trust_type)}
            </span>
          </h1>

          {/* Trust summary */}
          <div style={cardStyle}>
            <div style={sectionTitleStyle}>
              <Landmark size={14} style={{ color: 'var(--accent-primary)' }} /> Trust
            </div>
            <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '0.5rem 1.5rem', margin: 0 }}>
              <dt style={{ color: 'var(--text-muted)' }}>Trustee</dt>
              <dd style={{ margin: 0 }}>
                {trust.trustee_name ?? '—'}
                {trust.is_corporate_trustee ? ' (corporate)' : ''}
                {trust.trustee_abn ? <> · <code>{trust.trustee_abn}</code></> : null}
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
              <FileText size={14} style={{ color: 'var(--accent-primary)' }} /> Deed
            </div>
            {deed ? (
              <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '0.5rem 1.5rem', margin: 0 }}>
                <dt style={{ color: 'var(--text-muted)' }}>Deed date</dt>
                <dd style={{ margin: 0 }}>{formatDay(deed.deed_date)}</dd>
                <dt style={{ color: 'var(--text-muted)' }}>Vesting date</dt>
                <dd style={{ margin: 0 }}>{formatDay(deed.vesting_date)}</dd>
                <dt style={{ color: 'var(--text-muted)' }}>Streaming allowed</dt>
                <dd style={{ margin: 0 }}>{deed.streaming_allowed ? 'Yes' : 'No'}</dd>
                <dt style={{ color: 'var(--text-muted)' }}>Parsed terms</dt>
                <dd style={{ margin: 0 }}>
                  {deed.parsed_terms && Object.keys(deed.parsed_terms).length > 0 ? (
                    <pre style={{ margin: 0, fontSize: '0.8rem', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
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
                <Landmark size={14} style={{ color: 'var(--accent-primary)' }} /> Beneficiaries
                <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>({beneficiaries.length})</span>
              </span>
              {!adding && (
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => {
                    setAdding(true);
                    setDraft(EMPTY_BENEFICIARY);
                    setFormError(null);
                  }}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}
                >
                  <Plus size={14} /> Add
                </button>
              )}
            </div>

            {formError && (
              <div className="badge badge-danger" style={{ display: 'block', padding: '0.5rem', marginBottom: '0.75rem', textTransform: 'none' }}>
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
              <span style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>No beneficiaries yet.</span>
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
                            <span className="badge badge-neutral" style={{ fontSize: '11px', textTransform: 'none' }}>
                              {titleCase(b.beneficiary_type)}
                            </span>
                          </td>
                          <td>{b.relationship ? titleCase(b.relationship) : <span style={{ color: 'var(--text-muted)' }}>—</span>}</td>
                          <td>{b.abn ? <code>{b.abn}</code> : <span style={{ color: 'var(--text-muted)' }}>—</span>}</td>
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
        </>
      )}
    </section>
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
        style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}
      >
        <Save size={14} /> {saving ? 'Saving…' : 'Save'}
      </button>
      <button className="btn btn-ghost btn-sm" disabled={saving} onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}
