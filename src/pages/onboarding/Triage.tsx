import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';
import {
  useStagedEntities,
  type StagedEntity,
  type EntityKind,
} from '@/hooks/onboarding/useStagedEntities';
import { useIntakeCategories } from '@/hooks/useIntakeCategories';
import { ChevronLeft, Globe } from 'lucide-react';

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
      const {
        data: { session },
      } = await supabase.auth.getSession();
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
    (e) => (e.status === 'pending' || e.status === 'needs_review') && e.sonar_enriched_at == null,
  ).length;

  const groups = useMemo(() => {
    const out: Record<EntityKind, StagedEntity[]> = {
      supplier: [],
      contractor: [],
      customer: [],
      subscription: [],
      internal_admin: [],
      personal: [],
      unknown: [],
    };
    for (const e of entities) (out[e.predicted_kind] ?? out.unknown).push(e);
    return out;
  }, [entities]);

  if (!currentOrg) return <p style={{ color: 'var(--text-muted)' }}>Pick an organisation first.</p>;
  if (loading) return <p style={{ color: 'var(--text-muted)' }}>Loading triage list…</p>;

  const remaining = (progress?.pending_count ?? 0) + (progress?.needs_review_count ?? 0);

  const bulkApproveAllHighConfidence = async () => {
    const candidates = entities.filter(
      (e) =>
        (e.status === 'pending' || e.status === 'needs_review') &&
        e.predicted_category != null &&
        e.confidence >= 0.8,
    );
    if (candidates.length === 0) return;
    if (
      !confirm(
        `Approve ${candidates.length} entities with ≥80% AI confidence using their predicted classifications?\n\n` +
          `This will:\n` +
          `  • Create supplier/customer records for the right kinds\n` +
          `  • Insert intake_rules so future emails auto-route\n` +
          `  • Mark these as approved\n\n` +
          `You can still edit individually after.`,
      )
    )
      return;
    setBusy('bulk:high-conf');
    setError(null);
    let done = 0;
    try {
      for (const e of candidates) {
        await updateOneInternal(e, {
          status: 'approved',
          user_kind: e.predicted_kind,
          user_category: e.predicted_category,
        });
        done += 1;
      }
      await refresh();
    } catch (err) {
      setError(
        `Stopped at ${done}/${candidates.length}: ${err instanceof Error ? err.message : String(err)}`,
      );
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
    if (
      !confirm(
        `Approve ${candidates.length} entities using Sonar's fact-checked classifications (≥85% Sonar confidence)?\n\n` +
          `These have web-grounded summaries + citations. Sonar's kind/category will be used instead of the heuristic prediction.`,
      )
    )
      return;
    setBusy('bulk:sonar-conf');
    setError(null);
    let done = 0;
    try {
      for (const e of candidates) {
        const sonarKind = e.sonar_suggested_kind;
        const sonarCategory = e.sonar_suggested_category;
        if (sonarKind == null || sonarCategory == null) continue;
        await updateOneInternal(e, {
          status: 'approved',
          user_kind: sonarKind,
          user_category: sonarCategory,
        });
        done += 1;
      }
      await refresh();
    } catch (err) {
      setError(
        `Stopped at ${done}/${candidates.length}: ${err instanceof Error ? err.message : String(err)}`,
      );
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

  const bulkDismissJunk = async () => {
    const junk = entities.filter(
      (e) =>
        (e.status === 'pending' || e.status === 'needs_review') &&
        e.confidence < 0.4 &&
        (e.sonar_enriched_at == null || (e.sonar_confidence ?? 0) < 0.4) &&
        e.predicted_kind === 'unknown',
    );
    if (junk.length === 0) return;
    if (
      !confirm(
        `Dismiss ${junk.length} low-confidence "unknown" entities (Groq <40% AND Sonar <40% or unenriched)?\n\n` +
          `These are senders neither classifier could confidently identify — typically transactional noise (one-off receipts, marketing).`,
      )
    )
      return;
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
      setError(
        `Stopped at ${done}/${junk.length}: ${err instanceof Error ? err.message : String(err)}`,
      );
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
    const rows = (groups[kind] ?? []).filter(
      (e) => e.status === 'pending' || e.status === 'needs_review',
    );
    if (rows.length === 0) return;
    if (
      !confirm(
        `Approve all ${rows.length} ${kindLabel(kind)} entities using their predicted categories? You can still edit individually after.`,
      )
    )
      return;
    setBusy('bulk:' + kind);
    setError(null);
    try {
      for (const e of rows) {
        if (!e.predicted_category) continue;
        await updateOneInternal(e, {
          status: 'approved',
          user_kind: e.predicted_kind,
          user_category: e.predicted_category,
        });
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const bulkDismissGroup = async (kind: EntityKind) => {
    const rows = (groups[kind] ?? []).filter(
      (e) => e.status === 'pending' || e.status === 'needs_review',
    );
    if (rows.length === 0) return;
    if (
      !confirm(`Dismiss all ${rows.length} ${kindLabel(kind)} entities? They won't become rules.`)
    )
      return;
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
    updates: {
      status: 'approved' | 'dismissed';
      user_kind?: EntityKind;
      user_category?: string | null;
    },
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
      await onApprove(
        e,
        updates.user_kind ?? e.predicted_kind,
        updates.user_category ?? e.predicted_category,
      );
    }
  };

  const updateOne = async (
    e: StagedEntity,
    updates: {
      status: 'approved' | 'dismissed';
      user_kind?: EntityKind;
      user_category?: string | null;
    },
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
    if (!currentOrg) throw new Error('No organisation selected');
    const orgId = currentOrg.id;
    const matcher_value = e.canonical_key.startsWith('domain:')
      ? e.canonical_key.replace('domain:', '')
      : (e.primary_email ?? e.canonical_key.replace('email:', ''));
    const matcher_type = e.canonical_key.startsWith('domain:') ? 'sender_domain' : 'sender_address';

    let supplier_id: string | null = null;
    let customer_id: string | null = null;

    if (
      kind === 'supplier' ||
      kind === 'contractor' ||
      kind === 'subscription' ||
      kind === 'internal_admin'
    ) {
      const { data: sup, error: supErr } = await supabase
        .from('suppliers')
        .upsert(
          {
            organization_id: orgId,
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
            organization_id: orgId,
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
      organization_id: orgId,
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
    if (ruleErr && ruleErr.code !== '23505') {
      throw new Error(`intake_rules insert (${matcher_value}): ${ruleErr.message}`);
    }

    if (kind === 'subscription' && supplier_id) {
      const { error: subErr } = await supabase.from('subscriptions').upsert(
        {
          organization_id: orgId,
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
    <section className="animated-fade-in">
      {/* Header section */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '1.5rem',
          flexWrap: 'wrap',
          gap: '1rem',
        }}
      >
        <div>
          <h1 style={{ margin: 0 }}>Onboarding Triage</h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem', marginTop: '0.25rem' }}>
            Review, pre-categorise, and approve staged senders from your historical inbox messages.
          </p>
        </div>
        <Link
          to="/onboarding"
          className="btn btn-secondary"
          style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}
        >
          <ChevronLeft size={14} />
          <span>Back to Auto Setup</span>
        </Link>
      </div>

      {/* Progress tracking banner */}
      {progress && (
        <div className="card" style={{ padding: '1.25rem', marginBottom: '1.5rem' }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: '0.825rem',
              color: 'var(--text-muted)',
              marginBottom: '0.5rem',
              fontWeight: 600,
            }}
          >
            <span>
              {progress.approved_count + progress.dismissed_count} of {progress.total_entities}{' '}
              Reviewed · {remaining} Remaining
            </span>
            {progress.is_complete && (
              <span style={{ color: 'var(--text-success)' }}>✓ Onboarding complete</span>
            )}
          </div>
          <div
            style={{
              height: '8px',
              background: 'var(--bg-app)',
              borderRadius: 'var(--radius-full)',
              overflow: 'hidden',
              border: '1px solid var(--border-subtle)',
            }}
          >
            <div
              style={{
                width: `${progress.pct_complete}%`,
                height: '100%',
                background: progress.is_complete
                  ? 'var(--accent-success)'
                  : 'var(--accent-primary)',
                transition: 'width 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
              }}
            />
          </div>
        </div>
      )}

      {error && (
        <div
          className="badge badge-danger"
          style={{
            display: 'block',
            padding: '0.75rem',
            marginBottom: '1rem',
            textTransform: 'none',
          }}
        >
          {error}
        </div>
      )}

      {/* Perplexity Sonar fact checking card */}
      <div
        className="card"
        style={{
          borderLeft: '4px solid var(--accent-info)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '1rem',
          flexWrap: 'wrap',
          marginBottom: '1rem',
          padding: '1.25rem',
        }}
      >
        <div style={{ flex: 1, minWidth: '320px' }}>
          <div
            style={{
              fontWeight: 700,
              color: 'var(--text-title)',
              display: 'flex',
              alignItems: 'center',
              gap: '0.35rem',
            }}
          >
            <Globe size={16} style={{ color: 'var(--accent-info)' }} />
            <span>Fact-Check Senders with Perplexity AI</span>
          </div>
          <p
            style={{
              margin: '0.35rem 0 0 0',
              fontSize: '0.8rem',
              color: 'var(--text-muted)',
              lineHeight: '1.4',
            }}
          >
            Performs real-time web searches to verify the products or business nature of
            unrecognized senders and suggests high-accuracy tax classification.
            {sonarPendingCount > 0 &&
              ` There are ${sonarPendingCount} senders remaining to be enriched.`}
          </p>
        </div>
        <button
          onClick={() => void enrichWithSonar()}
          disabled={busy === 'sonar' || sonarPendingCount === 0}
          className="btn btn-primary"
          style={{
            background: 'var(--accent-info)',
            borderColor: 'var(--accent-info)',
            padding: '0.5rem 1rem',
          }}
        >
          {busy === 'sonar'
            ? 'Enriching senders…'
            : sonarPendingCount === 0
              ? '✓ All Enriched'
              : `Enrich next ${Math.min(60, sonarPendingCount)}`}
        </button>
      </div>

      {sonarMsg && (
        <div
          className="badge badge-success"
          style={{
            display: 'block',
            padding: '0.75rem',
            marginBottom: '1rem',
            textTransform: 'none',
          }}
        >
          {sonarMsg}
        </div>
      )}

      {/* Sonar Bulk approval banner */}
      {sonarHighConfCount > 0 && (
        <div
          className="card"
          style={{
            borderLeft: '4px solid var(--accent-info)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '1rem',
            flexWrap: 'wrap',
            marginBottom: '1rem',
            padding: '1.25rem',
          }}
        >
          <div>
            <strong style={{ color: 'var(--text-title)' }}>
              ✦ {sonarHighConfCount} Senders verified with high Sonar confidence
            </strong>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
              Approve all these fact-checked categories in one click, overriding default AI
              heuristic predictions.
            </div>
          </div>
          <button
            onClick={bulkApproveSonarHighConfidence}
            disabled={busy === 'bulk:sonar-conf'}
            className="btn btn-primary"
          >
            {busy === 'bulk:sonar-conf'
              ? 'Approving…'
              : `Approve all ${sonarHighConfCount} Sonar picks`}
          </button>
        </div>
      )}

      {/* Bulk Dismiss Noise banner */}
      {junkCount > 0 && (
        <div
          className="card"
          style={{
            borderLeft: '4px solid var(--accent-warning)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '1rem',
            flexWrap: 'wrap',
            marginBottom: '1rem',
            padding: '1.25rem',
          }}
        >
          <div>
            <strong style={{ color: 'var(--text-title)' }}>
              ⚠️ {junkCount} Low-confidence junk senders detected
            </strong>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
              These have less than 40% confidence and are likely newsletter, invoice notifications,
              or marketing noise.
            </div>
          </div>
          <button
            onClick={bulkDismissJunk}
            disabled={busy === 'bulk:junk'}
            className="btn btn-secondary"
            style={{ color: 'var(--text-danger)', borderColor: 'var(--accent-danger)' }}
          >
            {busy === 'bulk:junk' ? 'Dismissing…' : `Dismiss all ${junkCount} items`}
          </button>
        </div>
      )}

      {/* AI confidence bulk approval card */}
      {highConfCount > 0 && (
        <div
          className="card"
          style={{
            borderLeft: '4px solid var(--accent-success)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '1rem',
            flexWrap: 'wrap',
            marginBottom: '1.5rem',
            padding: '1.25rem',
          }}
        >
          <div>
            <strong style={{ color: 'var(--text-title)' }}>
              ✓ {highConfCount} Senders with ≥80% AI confidence predictions
            </strong>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
              Save time by bulk-approving all highly confident AI predictions into auto-intake
              rules.
            </div>
          </div>
          <button
            onClick={bulkApproveAllHighConfidence}
            disabled={busy === 'bulk:high-conf'}
            className="btn btn-primary"
            style={{ background: 'var(--accent-success)', borderColor: 'var(--accent-success)' }}
          >
            {busy === 'bulk:high-conf' ? 'Approving…' : `Approve all ${highConfCount} predictions`}
          </button>
        </div>
      )}

      {/* Triage Group Blocks */}
      {(
        [
          'supplier',
          'contractor',
          'subscription',
          'internal_admin',
          'customer',
          'personal',
          'unknown',
        ] as EntityKind[]
      ).map((k) => {
        const rows = groups[k] ?? [];
        if (rows.length === 0) return null;
        return (
          <div key={k} style={{ marginBottom: '2.5rem', animation: 'fadeIn 0.3s ease' }}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: '0.75rem',
                flexWrap: 'wrap',
                gap: '0.5rem',
              }}
            >
              <h2 style={{ fontSize: '1.1rem', margin: 0 }}>
                {kindLabel(k)} ({rows.length})
              </h2>
              <div style={{ display: 'flex', gap: '0.35rem' }}>
                <button
                  onClick={() => bulkApproveGroup(k)}
                  disabled={busy === 'bulk:' + k}
                  className="btn btn-secondary"
                  style={{
                    padding: '0.35rem 0.75rem',
                    fontSize: '0.75rem',
                    color: 'var(--text-success)',
                  }}
                >
                  ✓ Approve all {rows.length}
                </button>
                <button
                  onClick={() => bulkDismissGroup(k)}
                  disabled={busy === 'bulk:' + k}
                  className="btn btn-secondary"
                  style={{
                    padding: '0.35rem 0.75rem',
                    fontSize: '0.75rem',
                    color: 'var(--text-danger)',
                  }}
                >
                  ✕ Dismiss all
                </button>
              </div>
            </div>

            <div className="table-premium-container">
              <table className="table-premium">
                <thead>
                  <tr>
                    <th>Sender details</th>
                    <th>Sample subjects</th>
                    <th style={{ textAlign: 'right', width: '70px' }}>Emails</th>
                    <th style={{ textAlign: 'right', width: '70px' }}>Files</th>
                    <th>Category (Xero Account Code)</th>
                    <th style={{ width: '220px' }}>Review Action</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((e) => (
                    <TriageRow
                      key={e.id}
                      entity={e}
                      categories={categories}
                      busy={busy === e.id}
                      onApprove={(kind, category) =>
                        updateOne(e, {
                          status: 'approved',
                          user_kind: kind,
                          user_category: category,
                        })
                      }
                      onDismiss={() => updateOne(e, { status: 'dismissed' })}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}

      {entities.length === 0 && (
        <div
          style={{
            padding: '3rem',
            background: 'var(--bg-card)',
            border: '1px dashed var(--border-subtle)',
            borderRadius: 'var(--radius-md)',
            textAlign: 'center',
            color: 'var(--text-muted)',
          }}
        >
          No staged senders found yet. Run mailbox mining first.
        </div>
      )}
    </section>
  );
}

function TriageRow({
  entity,
  categories,
  busy,
  onApprove,
  onDismiss,
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
  const derivedKind = kindFromCategory(category) ?? kind;

  const sonarDiffers =
    (entity.sonar_suggested_category && entity.sonar_suggested_category !== category) ||
    (entity.sonar_suggested_kind && entity.sonar_suggested_kind !== derivedKind);

  const applySonar = () => {
    if (entity.sonar_suggested_category) setCategory(entity.sonar_suggested_category);
    if (entity.sonar_suggested_kind) setKind(entity.sonar_suggested_kind);
  };

  return (
    <tr style={{ opacity: isReviewed ? 0.65 : 1, transition: 'var(--transition-smooth)' }}>
      <td>
        <div style={{ fontWeight: 700, color: 'var(--text-title)' }}>{entity.display_name}</div>
        <div style={{ color: 'var(--text-muted)', fontSize: '0.75rem', marginTop: '0.15rem' }}>
          {entity.primary_email}
        </div>
        {entity.abn && (
          <div
            style={{
              color: 'var(--text-success)',
              fontSize: '0.7rem',
              fontWeight: 600,
              marginTop: '0.15rem',
            }}
          >
            ABN: {entity.abn}
          </div>
        )}

        {entity.sonar_summary && (
          <div
            style={{
              marginTop: '0.5rem',
              padding: '0.5rem',
              background: 'var(--bg-hover)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-sm)',
              fontSize: '0.775rem',
              color: 'var(--text-body)',
              maxWidth: '320px',
              lineHeight: '1.4',
            }}
          >
            <span style={{ color: 'var(--accent-info)', fontWeight: 700 }}>✦ Sonar Search:</span>{' '}
            {entity.sonar_summary}
            {entity.sonar_evidence_url && (
              <a
                href={entity.sonar_evidence_url}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  marginLeft: 6,
                  color: 'var(--accent-primary)',
                  fontSize: '0.7rem',
                  fontWeight: 600,
                }}
              >
                Source ↗
              </a>
            )}
          </div>
        )}
      </td>
      <td>
        {entity.sample_subjects.slice(0, 2).map((s, i) => (
          <div
            key={i}
            style={{
              color: 'var(--text-muted)',
              fontSize: '0.75rem',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              maxWidth: '240px',
              marginBottom: '0.15rem',
            }}
          >
            {s}
          </div>
        ))}
      </td>
      <td style={{ textAlign: 'right', fontFamily: 'ui-monospace, monospace' }}>
        {entity.message_count}
      </td>
      <td style={{ textAlign: 'right', fontFamily: 'ui-monospace, monospace' }}>
        {entity.attachment_count}
      </td>
      <td>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
          <select
            value={category ?? ''}
            onChange={(e) => setCategory(e.target.value || null)}
            disabled={busy || isReviewed}
            className="form-select"
            style={{ fontSize: '0.8rem', padding: '0.35rem 0.5rem' }}
          >
            <option value="">— select category —</option>
            {categories.map((c) => (
              <option key={c.code} value={c.code}>
                {c.label}
                {c.xero_account_code ? ` (${c.xero_account_code})` : ''}
              </option>
            ))}
          </select>
          <div style={{ color: 'var(--text-muted)', fontSize: '0.7rem', paddingLeft: '0.25rem' }}>
            Creates {kindActionLabel(derivedKind)} · {Math.round(entity.confidence * 100)}%
            confidence
          </div>

          {sonarDiffers && !isReviewed && (
            <button
              onClick={applySonar}
              disabled={busy}
              className="btn btn-secondary"
              style={{
                marginTop: '0.25rem',
                padding: '0.2rem 0.4rem',
                fontSize: '0.7rem',
                color: 'var(--text-info)',
                borderColor: 'var(--accent-info)',
                alignSelf: 'flex-start',
              }}
              title={`Sonar suggests: ${entity.sonar_suggested_category ?? '?'} (${entity.sonar_confidence != null ? Math.round(entity.sonar_confidence * 100) : '?'}%)`}
            >
              ✦ Use Sonar's pick
            </button>
          )}
        </div>
      </td>
      <td>
        {isReviewed ? (
          <span
            className={`badge ${entity.status === 'approved' ? 'badge-success' : 'badge-neutral'}`}
            style={{ padding: '0.35rem 0.75rem', display: 'inline-flex' }}
          >
            {entity.status}
          </span>
        ) : (
          <div style={{ display: 'flex', gap: '0.25rem' }}>
            <button
              onClick={() => onApprove(derivedKind, category)}
              disabled={busy || !category}
              className="btn btn-primary"
              style={{
                padding: '0.35rem 0.75rem',
                fontSize: '0.75rem',
                flex: 1,
                opacity: !category ? 0.5 : 1,
                background: 'var(--accent-success)',
                borderColor: 'var(--accent-success)',
              }}
              title={
                !category ? 'Pick a category first' : `Approve as ${kindActionLabel(derivedKind)}`
              }
            >
              {busy ? '…' : 'Approve'}
            </button>
            <button
              onClick={onDismiss}
              disabled={busy}
              className="btn btn-secondary"
              style={{
                padding: '0.35rem 0.5rem',
                fontSize: '0.75rem',
                color: 'var(--text-danger)',
                borderColor: 'var(--accent-danger)',
              }}
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
    case 'supplier':
      return 'Suppliers';
    case 'contractor':
      return 'Contractors';
    case 'customer':
      return 'Customers';
    case 'subscription':
      return 'Subscriptions';
    case 'internal_admin':
      return 'Government & Admin';
    case 'personal':
      return 'Personal Expenses';
    case 'unknown':
      return 'Needs Review';
  }
}

function kindActionLabel(k: EntityKind): string {
  switch (k) {
    case 'supplier':
      return 'Supplier';
    case 'contractor':
      return 'Subcontractor';
    case 'customer':
      return 'Customer';
    case 'subscription':
      return 'Subscription';
    case 'internal_admin':
      return 'Gov/Admin supplier';
    case 'personal':
      return 'Personal rule';
    case 'unknown':
      return 'Intake rule';
  }
}

function kindFromCategory(category: string | null): EntityKind | null {
  if (!category) return null;
  switch (category) {
    case 'customer_payment':
      return 'customer';
    case 'personal_expense':
      return 'personal';
    case 'subscriptions_saas':
    case 'telephone_internet':
      return 'subscription';
    case 'ato_bas_super':
      return 'internal_admin';
    case 'subcontractor':
      return 'contractor';
    case 'employee_wages':
    case 'bank_fees':
    case 'refunds':
    case 'uncategorized':
      return 'unknown';
    default:
      return 'supplier';
  }
}
