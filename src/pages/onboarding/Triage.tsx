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
  const [sonarMsg, setSonarMsg] = useState<string | null>(null);

  const enrichWithSonar = async () => {
    if (!currentOrg) return;
    setBusy('sonar');
    setSonarMsg(null);
    setError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not signed in');
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/staged-entities-enrich-sonar`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ organization_id: currentOrg.id, batch_size: 15, max_batches: 4 }),
      });
      const body = await res.json();
      if (!res.ok || !body.ok) throw new Error(body.error ?? `${res.status}`);
      setSonarMsg(
        `Sonar enriched ${body.stats.enriched} (${body.stats.errors} errors). ${body.remaining} entities still un-enriched.`,
      );
      await refresh();
    } catch (err) {
      setError(`Sonar enrich: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const sonarPendingCount = entities.filter(
    (e) =>
      (e.status === 'pending' || e.status === 'needs_review') &&
      e.sonar_enriched_at == null,
  ).length;

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

  // Sonar-aware bulk approve: prefer Sonar's pick when it's confident.
  const bulkApproveSonarHighConfidence = async () => {
    const candidates = entities.filter(
      (e) =>
        (e.status === 'pending' || e.status === 'needs_review') &&
        e.sonar_enriched_at != null &&
        e.sonar_confidence != null &&
        e.sonar_confidence >= 0.85 &&
        e.sonar_suggested_kind != null &&
        e.sonar_suggested_category != null,
    );
    if (candidates.length === 0) return;
    if (!confirm(
      `Approve ${candidates.length} entities using Sonar's fact-checked classifications (≥85% Sonar confidence)?\n\n`
      + `These have web-grounded summaries + citations. Sonar's kind/category will be used instead of the heuristic prediction.`,
    )) return;
    setBusy('bulk:sonar-conf');
    setError(null);
    let done = 0;
    try {
      for (const e of candidates) {
        await updateOneInternal(e, {
          status: 'approved',
          user_kind: e.sonar_suggested_kind!,
          user_category: e.sonar_suggested_category!,
        });
        done += 1;
      }
      await refresh();
    } catch (err) {
      setError(`Stopped at ${done}/${candidates.length}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const sonarHighConfCount = entities.filter(
    (e) =>
      (e.status === 'pending' || e.status === 'needs_review') &&
      e.sonar_enriched_at != null &&
      e.sonar_confidence != null &&
      e.sonar_confidence >= 0.85 &&
      e.sonar_suggested_kind != null &&
      e.sonar_suggested_category != null,
  ).length;

  // Bulk dismiss: low-confidence, no category, no Sonar evidence — likely junk
  const bulkDismissJunk = async () => {
    const junk = entities.filter(
      (e) =>
        (e.status === 'pending' || e.status === 'needs_review') &&
        e.confidence < 0.4 &&
        (e.sonar_enriched_at == null || (e.sonar_confidence ?? 0) < 0.4) &&
        e.predicted_kind === 'unknown',
    );
    if (junk.length === 0) return;
    if (!confirm(
      `Dismiss ${junk.length} low-confidence "unknown" entities (Groq <40% AND Sonar <40% or unenriched)?\n\n`
      + `These are senders neither classifier could confidently identify — typically transactional noise (one-off receipts, marketing).`,
    )) return;
    setBusy('bulk:junk');
    setError(null);
    let done = 0;
    try {
      for (const e of junk) {
        await updateOneInternal(e, { status: 'dismissed' });
        done += 1;
      }
      await refresh();
    } catch (err) {
      setError(`Stopped at ${done}/${junk.length}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const junkCount = entities.filter(
    (e) =>
      (e.status === 'pending' || e.status === 'needs_review') &&
      e.confidence < 0.4 &&
      (e.sonar_enriched_at == null || (e.sonar_confidence ?? 0) < 0.4) &&
      e.predicted_kind === 'unknown',
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
      if (supErr) throw new Error(`suppliers upsert (${e.display_name}): ${supErr.message}`);
      if (sup) supplier_id = sup.id as string;
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
      if (custErr) throw new Error(`customers upsert (${e.display_name}): ${custErr.message}`);
      if (cust) customer_id = cust.id as string;
    }

    const isPersonal = kind === 'personal' || category === 'personal_expense';
    const { error: ruleErr } = await supabase.from('intake_rules').insert({
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
    // Duplicate rules (same matcher_value) are not an error here — re-approving
    // a sender shouldn't fail. Only surface non-23505 errors.
    if (ruleErr && ruleErr.code !== '23505') {
      throw new Error(`intake_rules insert (${matcher_value}): ${ruleErr.message}`);
    }

    if (kind === 'subscription' && supplier_id) {
      const { error: subErr } = await supabase.from('subscriptions').upsert(
        {
          organization_id: currentOrg!.id,
          merchant_name: e.display_name,
          merchant_canonical_key: e.canonical_key,
          supplier_id,
          status: 'candidate',
          cadence: 'irregular',
          amount_cents: 0,
          confidence: e.confidence,
          detection_reason: 'email_classifier',
          observed_count: 0,
          total_spent_cents: 0,
          first_seen_at: e.first_seen_at ?? new Date().toISOString(),
          last_seen_at: e.last_seen_at ?? new Date().toISOString(),
        },
        { onConflict: 'organization_id,merchant_canonical_key', ignoreDuplicates: true },
      );
      if (subErr && subErr.code !== '23505') {
        throw new Error(`subscriptions upsert (${e.display_name}): ${subErr.message}`);
      }
    }

    if (supplier_id || customer_id) {
      const { error: linkErr } = await supabase
        .from('staged_entities')
        .update({
          resolved_supplier_id: supplier_id,
          resolved_customer_id: customer_id,
        })
        .eq('id', e.id);
      if (linkErr) throw new Error(`staged_entities link (${e.id}): ${linkErr.message}`);
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

      <div style={{
        marginBottom: 16,
        padding: 10,
        background: '#0e1820',
        border: '1px solid #1f3a52',
        borderRadius: 6,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 12,
        flexWrap: 'wrap',
      }}>
        <div>
          <strong style={{ color: '#7fb6e8' }}>✦ Sonar fact-check</strong>
          <div style={{ fontSize: 11, color: '#9ab0c0', marginTop: 3 }}>
            Use Perplexity Sonar (web-grounded) to verify what each sender actually does + suggest a category with citation.
            {sonarPendingCount > 0 && ` ${sonarPendingCount} entit${sonarPendingCount === 1 ? 'y' : 'ies'} not yet enriched.`}
          </div>
        </div>
        <button
          onClick={() => void enrichWithSonar()}
          disabled={busy === 'sonar' || sonarPendingCount === 0}
          style={{
            padding: '0.5rem 1rem',
            background: '#1c4868',
            color: '#fff',
            border: '1px solid #5096d8',
            borderRadius: 4,
            fontSize: 12,
            fontWeight: 600,
            cursor: busy === 'sonar' || sonarPendingCount === 0 ? 'wait' : 'pointer',
          }}
        >
          {busy === 'sonar' ? 'Enriching…' : sonarPendingCount === 0 ? '✓ All enriched' : `✦ Enrich next ${Math.min(60, sonarPendingCount)} with Sonar`}
        </button>
      </div>
      {sonarMsg && (
        <p style={{ marginTop: 4, marginBottom: 16, fontSize: 12, color: '#86c7a3' }}>{sonarMsg}</p>
      )}

      {sonarHighConfCount > 0 && (
        <div style={{
          marginBottom: 16,
          padding: 12,
          background: '#0e1820',
          border: '1px solid #1f4d70',
          borderRadius: 6,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
        }}>
          <div>
            <strong style={{ color: '#7fb6e8' }}>
              ✦ {sonarHighConfCount} entit{sonarHighConfCount === 1 ? 'y' : 'ies'} fact-checked by Sonar with ≥85% confidence
            </strong>
            <div style={{ fontSize: 11, color: '#9ab0c0', marginTop: 3 }}>
              One click approves all using Sonar's web-verified kind + category (overrides Groq's heuristic guess).
            </div>
          </div>
          <button
            onClick={bulkApproveSonarHighConfidence}
            disabled={busy === 'bulk:sonar-conf'}
            style={{
              padding: '0.5rem 1.25rem',
              background: '#1c4868',
              color: '#fff',
              border: '1px solid #5096d8',
              borderRadius: 4,
              fontSize: 13,
              fontWeight: 600,
              cursor: busy === 'bulk:sonar-conf' ? 'wait' : 'pointer',
            }}
          >
            {busy === 'bulk:sonar-conf' ? 'Approving…' : `✦ Approve all ${sonarHighConfCount} Sonar picks`}
          </button>
        </div>
      )}

      {junkCount > 0 && (
        <div style={{
          marginBottom: 16,
          padding: 10,
          background: '#1d1410',
          border: '1px solid #3d2818',
          borderRadius: 6,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
        }}>
          <div>
            <span style={{ color: '#d2a886', fontWeight: 600 }}>
              {junkCount} low-confidence "unknown" sender{junkCount === 1 ? '' : 's'}
            </span>
            <div style={{ fontSize: 11, color: '#a89380', marginTop: 3 }}>
              Both Groq and Sonar have &lt;40% confidence — likely one-off receipts / marketing / noise.
            </div>
          </div>
          <button
            onClick={bulkDismissJunk}
            disabled={busy === 'bulk:junk'}
            style={{
              padding: '0.4rem 1rem',
              background: 'transparent',
              color: '#e9a3a3',
              border: '1px solid #5d2828',
              borderRadius: 4,
              fontSize: 12,
              cursor: busy === 'bulk:junk' ? 'wait' : 'pointer',
            }}
          >
            {busy === 'bulk:junk' ? 'Dismissing…' : `✕ Dismiss all ${junkCount}`}
          </button>
        </div>
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

  const sonarKindDiffers = entity.sonar_suggested_kind && entity.sonar_suggested_kind !== kind;
  const sonarCatDiffers = entity.sonar_suggested_category && entity.sonar_suggested_category !== category;
  const applySonar = () => {
    if (entity.sonar_suggested_kind) setKind(entity.sonar_suggested_kind);
    if (entity.sonar_suggested_category) setCategory(entity.sonar_suggested_category);
  };

  return (
    <tr style={{ borderBottom: '1px solid #1a1a1a', opacity: isReviewed ? 0.5 : 1 }}>
      <td style={td}>
        <div style={{ fontWeight: 600 }}>{entity.display_name}</div>
        <div style={{ color: '#888', fontSize: 11 }}>{entity.primary_email}</div>
        {entity.abn && <div style={{ color: '#86c7a3', fontSize: 10 }}>ABN {entity.abn}</div>}
        {entity.sonar_summary && (
          <div style={{
            marginTop: 6,
            padding: '4px 6px',
            background: '#0e1820',
            border: '1px solid #1f3a52',
            borderRadius: 3,
            fontSize: 11,
            color: '#9ab0c0',
            maxWidth: 340,
            lineHeight: 1.35,
          }}>
            <span style={{ color: '#7fb6e8', fontWeight: 600 }}>✦ Sonar:</span> {entity.sonar_summary}
            {entity.sonar_evidence_url && (
              <a
                href={entity.sonar_evidence_url}
                target="_blank"
                rel="noopener noreferrer"
                style={{ marginLeft: 6, color: '#5096d8', fontSize: 10, textDecoration: 'none' }}
              >source ↗</a>
            )}
          </div>
        )}
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
        {(sonarKindDiffers || sonarCatDiffers) && !isReviewed && (
          <button
            onClick={applySonar}
            disabled={busy}
            style={{
              marginTop: 4, padding: '0.15rem 0.5rem',
              background: '#1c4868', color: '#9bcaf3',
              border: '1px solid #5096d8', borderRadius: 3,
              fontSize: 10, cursor: 'pointer',
            }}
            title={`Sonar suggests: ${entity.sonar_suggested_kind ?? '?'}/${entity.sonar_suggested_category ?? '?'} (${entity.sonar_confidence != null ? Math.round(entity.sonar_confidence * 100) : '?'}%)`}
          >✦ Use Sonar's pick</button>
        )}
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
        {entity.sonar_suggested_category && entity.sonar_suggested_category !== category && (
          <div style={{ fontSize: 10, color: '#7fb6e8', marginTop: 2 }}>
            ✦ Sonar: {entity.sonar_suggested_category}
          </div>
        )}
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
