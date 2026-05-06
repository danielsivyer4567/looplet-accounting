import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/contexts/OrgContext';
import {
  useStagedEntities,
  type StagedEntity,
  type EntityKind,
} from '@/hooks/onboarding/useStagedEntities';
import { useIntakeCategories } from '@/hooks/useIntakeCategories';

/**
 * Auto Setup → Triage. Every staged entity must be approved or dismissed
 * before Auto Setup is considered "complete". Approval creates a row in
 * `intake_rules` so future intake auto-applies the user's classification.
 *
 * Gap-proofing:
 * - Entities default to predicted classification but every row needs a click.
 * - The "Finish onboarding" button is disabled until pending+needs_review = 0.
 * - Re-running gmail-mine never downgrades a row already approved/dismissed.
 */
export function TriagePage() {
  const { currentOrg } = useOrg();
  const { entities, progress, refresh, loading } = useStagedEntities();
  const { categories } = useIntakeCategories();

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Group by predicted_kind for easier scanning
  const groups = useMemo(() => {
    const out: Record<EntityKind, StagedEntity[]> = {
      supplier: [], contractor: [], customer: [], subscription: [],
      internal_admin: [], personal: [], unknown: [],
    };
    for (const e of entities) (out[e.predicted_kind] ?? out.unknown).push(e);
    return out;
  }, [entities]);

  if (!currentOrg) return <p style={{ color: '#888' }}>Pick an organisation first.</p>;
  if (loading) return <p style={{ color: '#888' }}>Loading…</p>;

  const remaining = (progress?.pending_count ?? 0) + (progress?.needs_review_count ?? 0);

  const bulkApproveAllHighConfidence = async () => {
    const candidates = entities.filter(
      (e) =>
        (e.status === 'pending' || e.status === 'needs_review') &&
        e.predicted_category != null &&
        e.confidence >= 0.8,
    );
    if (candidates.length === 0) return;
    if (!confirm(
      `Approve ${candidates.length} entities with ≥80% AI confidence using their predicted classifications?\n\n`
      + `This will:\n`
      + `  • Create supplier/customer records for the right kinds\n`
      + `  • Insert intake_rules so future emails auto-route\n`
      + `  • Mark these as approved\n\n`
      + `You can still edit individually after.`,
    )) return;
    setBusy('bulk:high-conf');
    setError(null);
    let done = 0;
    try {
      for (const e of candidates) {
        await updateOneInternal(e, { status: 'approved', user_kind: e.predicted_kind, user_category: e.predicted_category });
        done += 1;
      }
      await refresh();
    } catch (err) {
      setError(`Stopped at ${done}/${candidates.length}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const highConfCount = entities.filter(
    (e) =>
      (e.status === 'pending' || e.status === 'needs_review') &&
      e.predicted_category != null &&
      e.confidence >= 0.8,
  ).length;

  const bulkApproveGroup = async (kind: EntityKind) => {
    const rows = (groups[kind] ?? []).filter((e) => e.status === 'pending' || e.status === 'needs_review');
    if (rows.length === 0) return;
    if (!confirm(`Approve all ${rows.length} ${kindLabel(kind)} entities using their predicted categories? You can still edit individually after.`)) return;
    setBusy('bulk:' + kind);
    setError(null);
    try {
      for (const e of rows) {
        if (!e.predicted_category) continue;
        await updateOneInternal(e, { status: 'approved', user_kind: e.predicted_kind, user_category: e.predicted_category });
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const bulkDismissGroup = async (kind: EntityKind) => {
    const rows = (groups[kind] ?? []).filter((e) => e.status === 'pending' || e.status === 'needs_review');
    if (rows.length === 0) return;
    if (!confirm(`Dismiss all ${rows.length} ${kindLabel(kind)} entities? They won't become rules.`)) return;
    setBusy('bulk:' + kind);
    setError(null);
    try {
      for (const e of rows) {
        await updateOneInternal(e, { status: 'dismissed' });
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const updateOneInternal = async (
    e: StagedEntity,
    updates: { status: 'approved' | 'dismissed'; user_kind?: EntityKind; user_category?: string | null },
  ) => {
    const { error: ueErr } = await supabase
      .from('staged_entities')
      .update({
        status: updates.status,
        user_kind: updates.user_kind ?? e.predicted_kind,
        user_category: updates.user_category ?? e.predicted_category,
        reviewed_at: new Date().toISOString(),
      })
      .eq('id', e.id);
    if (ueErr) throw ueErr;

    if (updates.status === 'approved') {
      await onApprove(e, updates.user_kind ?? e.predicted_kind, updates.user_category ?? e.predicted_category);
    }
  };

  const updateOne = async (
    e: StagedEntity,
    updates: { status: 'approved' | 'dismissed'; user_kind?: EntityKind; user_category?: string | null },
  ) => {
    setError(null);
    setBusy(e.id);
    try {
      await updateOneInternal(e, updates);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const onApprove = async (e: StagedEntity, kind: EntityKind, category: string | null) => {
    const matcher_value = e.canonical_key.startsWith('domain:')
      ? e.canonical_key.replace('domain:', '')
      : e.primary_email ?? e.canonical_key.replace('email:', '');
    const matcher_type = e.canonical_key.startsWith('domain:') ? 'sender_domain' : 'sender_address';

    let supplier_id: string | null = null;
    let customer_id: string | null = null;

    if (kind === 'supplier' || kind === 'contractor' || kind === 'subscription' || kind === 'internal_admin') {
      // Upsert supplier
      const { data: sup, error: supErr } = await supabase
        .from('suppliers')
        .upsert(
          {
            organization_id: currentOrg!.id,
            name: e.display_name,
            email: e.primary_email,
            abn: e.abn,
          },
          { onConflict: 'organization_id,name', ignoreDuplicates: false },
        )
        .select('id')
        .single();
      if (!supErr && sup) supplier_id = sup.id as string;
    } else if (kind === 'customer') {
      const { data: cust, error: custErr } = await supabase
        .from('customers')
        .upsert(
          {
            organization_id: currentOrg!.id,
            name: e.display_name,
            email: e.primary_email,
          },
          { onConflict: 'organization_id,name', ignoreDuplicates: false },
        )
        .select('id')
        .single();
      if (!custErr && cust) customer_id = cust.id as string;
    }

    // Create rule (skip for personal — no Xero mapping)
    const isPersonal = kind === 'personal' || category === 'personal_expense';
    await supabase.from('intake_rules').insert({
      organization_id: currentOrg!.id,
      matcher_type,
      matcher_value,
      matcher_priority: matcher_type === 'sender_address' ? 50 : 100,
      category_code: category,
      supplier_id,
      customer_id,
      is_personal: isPersonal,
      skip_ocr: false,
      notes: `Auto Setup — predicted ${e.predicted_kind} (${e.confidence})`,
    });

    // Link the staged entity to the supplier/customer
    if (supplier_id || customer_id) {
      await supabase
        .from('staged_entities')
        .update({
          resolved_supplier_id: supplier_id,
          resolved_customer_id: customer_id,
        })
        .eq('id', e.id);
    }
  };

  return (
    <section>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
        <h1>Triage</h1>
        <Link to="/onboarding" style={{ color: '#888', fontSize: 13 }}>← back to Auto Setup</Link>
      </div>
      {progress && (
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 13, color: '#aaa', marginBottom: 6 }}>
            {progress.approved_count + progress.dismissed_count} of {progress.total_entities} reviewed
            · {remaining} remaining
            {progress.is_complete && <span style={{ color: '#86c7a3', marginLeft: 8 }}>✓ complete</span>}
          </div>
          <div style={{ height: 6, background: '#0a0a0a', borderRadius: 3, overflow: 'hidden' }}>
            <div
              style={{
                width: `${progress.pct_complete}%`,
                height: '100%',
                background: progress.is_complete ? '#2da565' : '#5096d8',
                transition: 'width 0.3s',
              }}
            />
          </div>
        </div>
      )}

      {error && (
        <p style={{ color: 'salmon', fontSize: 12 }}>{error}</p>
      )}

      {highConfCount > 0 && (
        <div style={{
          marginBottom: 24,
          padding: 12,
          background: '#0d2f1f',
          border: '1px solid #1c5135',
          borderRadius: 6,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
        }}>
          <div>
            <strong style={{ color: '#86c7a3' }}>
              {highConfCount} entit{highConfCount === 1 ? 'y has' : 'ies have'} high-confidence (≥80%) AI predictions
            </strong>
            <div style={{ fontSize: 11, color: '#aaa', marginTop: 3 }}>
              One click approves all of them, creates supplier/customer records, and inserts intake_rules for auto-routing.
            </div>
          </div>
          <button
            onClick={bulkApproveAllHighConfidence}
            disabled={busy === 'bulk:high-conf'}
            style={{
              padding: '0.5rem 1.25rem',
              background: '#1c5135',
              color: '#fff',
              border: '1px solid #2da565',
              borderRadius: 4,
              fontSize: 13,
              fontWeight: 600,
              cursor: busy === 'bulk:high-conf' ? 'wait' : 'pointer',
            }}
          >
            {busy === 'bulk:high-conf' ? 'Approving…' : `✓ Approve all ${highConfCount} high-confidence`}
          </button>
        </div>
      )}

      {(['supplier', 'contractor', 'subscription', 'internal_admin', 'customer', 'personal', 'unknown'] as EntityKind[]).map((k) => {
        const rows = groups[k] ?? [];
        if (rows.length === 0) return null;
        return (
          <div key={k} style={{ marginBottom: 32 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <h2 style={{ fontSize: 14, color: '#aaa', textTransform: 'uppercase', letterSpacing: 0.5, margin: 0 }}>
                {kindLabel(k)} ({rows.length})
              </h2>
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  onClick={() => bulkApproveGroup(k)}
                  disabled={busy === 'bulk:' + k}
                  style={{ ...btn, background: '#1c5135', color: '#86c7a3', borderColor: '#2da565' }}
                >
                  {busy === 'bulk:' + k ? '…' : '✓ Approve all predictions'}
                </button>
                <button
                  onClick={() => bulkDismissGroup(k)}
                  disabled={busy === 'bulk:' + k}
                  style={{ ...btn, background: 'transparent', color: '#e9a3a3', borderColor: '#3d1818' }}
                >
                  ✕ Dismiss all
                </button>
              </div>
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #2a2a2a' }}>
                  <th style={th}>Sender</th>
                  <th style={th}>Sample subjects</th>
                  <th style={thRight}>Msgs</th>
                  <th style={thRight}>Att.</th>
                  <th style={th}>Predicted</th>
                  <th style={th}>Category</th>
                  <th style={th}></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => (
                  <TriageRow
                    key={e.id}
                    entity={e}
                    categories={categories}
                    busy={busy === e.id}
                    onApprove={(kind, category) => updateOne(e, { status: 'approved', user_kind: kind, user_category: category })}
                    onDismiss={() => updateOne(e, { status: 'dismissed' })}
                  />
                ))}
              </tbody>
            </table>
          </div>
        );
      })}

      {entities.length === 0 && (
        <p style={{ color: '#888' }}>No staged entities yet. Run Auto Setup mining first.</p>
      )}
    </section>
  );
}

function TriageRow({
  entity, categories, busy, onApprove, onDismiss,
}: {
  entity: StagedEntity;
  categories: { code: string; label: string; xero_account_code: string | null }[];
  busy: boolean;
  onApprove: (kind: EntityKind, category: string | null) => void;
  onDismiss: () => void;
}) {
  const [kind, setKind] = useState<EntityKind>(entity.predicted_kind);
  const [category, setCategory] = useState<string | null>(entity.predicted_category);

  const isReviewed = entity.status === 'approved' || entity.status === 'dismissed';

  return (
    <tr style={{ borderBottom: '1px solid #1a1a1a', opacity: isReviewed ? 0.5 : 1 }}>
      <td style={td}>
        <div style={{ fontWeight: 600 }}>{entity.display_name}</div>
        <div style={{ color: '#888', fontSize: 11 }}>{entity.primary_email}</div>
        {entity.abn && <div style={{ color: '#86c7a3', fontSize: 10 }}>ABN {entity.abn}</div>}
      </td>
      <td style={td}>
        {entity.sample_subjects.slice(0, 2).map((s, i) => (
          <div key={i} style={{ color: '#aaa', fontSize: 11, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 280 }}>
            {s}
          </div>
        ))}
      </td>
      <td style={tdRight}>{entity.message_count}</td>
      <td style={tdRight}>{entity.attachment_count}</td>
      <td style={td}>
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as EntityKind)}
          disabled={busy || isReviewed}
          style={selectStyle}
        >
          {(['supplier', 'contractor', 'subscription', 'internal_admin', 'customer', 'personal', 'unknown'] as EntityKind[]).map((k) => (
            <option key={k} value={k}>{kindLabel(k)}</option>
          ))}
        </select>
        <div style={{ color: '#666', fontSize: 10, marginTop: 2 }}>
          {Math.round(entity.confidence * 100)}% · {entity.prediction_reason}
        </div>
      </td>
      <td style={td}>
        <select
          value={category ?? ''}
          onChange={(e) => setCategory(e.target.value || null)}
          disabled={busy || isReviewed}
          style={selectStyle}
        >
          <option value="">— pick —</option>
          {categories.map((c) => (
            <option key={c.code} value={c.code}>
              {c.label}{c.xero_account_code ? ` (${c.xero_account_code})` : ''}
            </option>
          ))}
        </select>
      </td>
      <td style={td}>
        {isReviewed ? (
          <span style={{ color: entity.status === 'approved' ? '#86c7a3' : '#888', fontSize: 11 }}>
            {entity.status}
          </span>
        ) : (
          <div style={{ display: 'flex', gap: 4 }}>
            <button
              onClick={() => onApprove(kind, category)}
              disabled={busy}
              style={{ ...btn, background: '#1c5135', color: '#86c7a3', borderColor: '#2da565' }}
            >
              {busy ? '…' : '✓ Approve'}
            </button>
            <button
              onClick={onDismiss}
              disabled={busy}
              style={{ ...btn, background: 'transparent', color: '#e9a3a3', borderColor: '#3d1818' }}
            >
              ✕ Dismiss
            </button>
          </div>
        )}
      </td>
    </tr>
  );
}

function kindLabel(k: EntityKind): string {
  switch (k) {
    case 'supplier': return 'Suppliers';
    case 'contractor': return 'Contractors';
    case 'customer': return 'Customers';
    case 'subscription': return 'Subscriptions';
    case 'internal_admin': return 'Government / admin';
    case 'personal': return 'Personal';
    case 'unknown': return 'Needs review';
  }
}

const th: React.CSSProperties = {
  padding: '0.4rem 0.5rem',
  textAlign: 'left',
  fontSize: 11,
  color: '#888',
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  fontWeight: 500,
};
const thRight: React.CSSProperties = { ...th, textAlign: 'right' };
const td: React.CSSProperties = { padding: '0.6rem 0.5rem', verticalAlign: 'top' };
const tdRight: React.CSSProperties = { ...td, textAlign: 'right' };
const selectStyle: React.CSSProperties = {
  background: '#0a0a0a',
  color: '#fff',
  border: '1px solid #2a2a2a',
  borderRadius: 3,
  padding: '0.25rem 0.4rem',
  fontSize: 12,
};
const btn: React.CSSProperties = {
  border: '1px solid',
  borderRadius: 3,
  fontSize: 11,
  padding: '0.25rem 0.5rem',
  cursor: 'pointer',
};
