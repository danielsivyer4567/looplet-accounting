import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { OrgProfileForm } from '@/components/settings/OrgProfile';
import { BusinessProfileForm } from '@/components/settings/BusinessProfileForm';
import { GmailConnect } from '@/components/settings/GmailConnect';
import { BankConnect } from '@/components/settings/BankConnect';
import { XeroConnect } from '@/components/settings/XeroConnect';
import { PayerBankDetails } from '@/components/settings/PayerBankDetails';
import { ApiKeys } from '@/components/settings/ApiKeys';
import { SkeletonLine } from '@/components/Skeleton';
import {
  User,
  Lock,
  Bell,
  Eye,
  Shield,
  ChevronRight,
  Info,
  X,
  Cpu,
  Trash2,
  Plus,
} from 'lucide-react';
import {
  type AutomationConfidence,
  type DecisionSourceKind,
  type DecisionKind,
  type ConfidencePolicy,
  listConfidencePolicies,
  createConfidencePolicy,
  deleteConfidencePolicy,
} from '@/lib/automationDecision';
import { useOrg } from '@/hooks/useOrg';
import { supabase } from '@/lib/supabase';

type SettingsCategory = 'account' | 'privacy' | 'notification' | 'appearance' | 'automation';

const SOURCE_KIND_OPTIONS: DecisionSourceKind[] = [
  'bill_upload',
  'bank_match',
  'coding_suggestion',
  'receipt_ocr',
];

const TASK_TYPE_OPTIONS: DecisionKind[] = [
  'supplier_match',
  'category',
  'gst_treatment',
  'job_tag',
  'asset_treatment',
];

const CONFIDENCE_OPTIONS: AutomationConfidence[] = [
  'auto_post',
  'quick_confirm',
  'review_needed',
  'advisor_required',
  'blocked_external',
];

// The one marketing consent Looplet asks for. Off until the user turns it on, and saved to their
// account (auth user metadata) with the time it changed, so the choice is a real, dated record.
const PRODUCT_EMAIL_CONSENT_KEY = 'product_email_consent';

interface ProductEmailConsentRecord {
  granted: boolean;
  updated_at: string;
}

function readProductEmailConsent(metadata: Record<string, unknown> | undefined): boolean {
  const record = metadata?.[PRODUCT_EMAIL_CONSENT_KEY] as ProductEmailConsentRecord | undefined;
  return record?.granted === true;
}

function ProductEmailConsent() {
  const [granted, setGranted] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void supabase.auth.getUser().then(({ data }) => {
      if (cancelled) return;
      setGranted(readProductEmailConsent(data.user?.user_metadata));
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggle = async () => {
    const next = !granted;
    setSaving(true);
    setMessage(null);
    setError(null);
    const record: ProductEmailConsentRecord = {
      granted: next,
      updated_at: new Date().toISOString(),
    };
    const { error: saveError } = await supabase.auth.updateUser({
      data: { [PRODUCT_EMAIL_CONSENT_KEY]: record },
    });
    setSaving(false);
    if (saveError) {
      setError(`Not saved: ${saveError.message}`);
      return;
    }
    setGranted(next);
    setMessage(
      next ? 'Saved: you will get product news emails.' : 'Saved: no product news emails.',
    );
  };

  return (
    <div>
      <div className="card" style={{ padding: '0.5rem 0' }}>
        <div className="settings-row">
          <div>
            <div
              id="product-email-consent-label"
              style={{ fontWeight: 600, fontSize: '0.85rem', color: 'var(--text-title)' }}
            >
              Product news from Looplet
            </div>
            <div
              style={{
                fontSize: '0.75rem',
                color: 'var(--text-muted)',
                marginTop: '0.15rem',
                lineHeight: 1.4,
              }}
            >
              Occasional emails about new Looplet features and offers. Off unless you turn it on,
              and you can turn it off at any time. Account emails, such as sign-in links and team
              invitations, are sent either way.
            </div>
          </div>
          <label className="switch">
            <input
              type="checkbox"
              role="switch"
              aria-labelledby="product-email-consent-label"
              checked={granted}
              disabled={!loaded || saving}
              onChange={() => void toggle()}
            />
            <span className="slider" />
          </label>
        </div>
      </div>
      {message && (
        <p role="status" style={{ color: 'var(--text-success)', fontSize: '0.8rem' }}>
          {message}
        </p>
      )}
      {error && (
        <p role="alert" style={{ color: 'var(--text-danger)', fontSize: '0.8rem' }}>
          {error}
        </p>
      )}
    </div>
  );
}

export function SettingsPage() {
  const { currentOrg } = useOrg();
  const [activeCategory, setActiveCategory] = useState<SettingsCategory>('notification');

  // Automation / confidence policy state
  const [policies, setPolicies] = useState<ConfidencePolicy[]>([]);
  const [policiesLoading, setPoliciesLoading] = useState(false);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const [addingPolicy, setAddingPolicy] = useState(false);
  const [newPolicy, setNewPolicy] = useState<{
    source_kind: DecisionSourceKind;
    task_type: DecisionKind;
    policy: AutomationConfidence;
  }>({ source_kind: 'bill_upload', task_type: 'category', policy: 'review_needed' });

  useEffect(() => {
    if (activeCategory !== 'automation' || !currentOrg) return;
    setPoliciesLoading(true);
    setPolicyError(null);
    listConfidencePolicies(currentOrg.id)
      .then(setPolicies)
      .catch((e: unknown) => setPolicyError(e instanceof Error ? e.message : String(e)))
      .finally(() => setPoliciesLoading(false));
  }, [activeCategory, currentOrg]);

  async function handleAddPolicy() {
    if (!currentOrg) return;
    setPolicyError(null);
    try {
      const created = await createConfidencePolicy({
        organizationId: currentOrg.id,
        sourceKind: newPolicy.source_kind,
        taskType: newPolicy.task_type,
        policy: newPolicy.policy,
      });
      setPolicies((prev) => [created, ...prev]);
      setAddingPolicy(false);
    } catch (e: unknown) {
      setPolicyError(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleDeletePolicy(id: string) {
    if (!currentOrg) return;
    setPolicyError(null);
    try {
      await deleteConfidencePolicy({ policyId: id, organizationId: currentOrg.id });
      setPolicies((prev) => prev.filter((p) => p.id !== id));
    } catch (e: unknown) {
      setPolicyError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <section className="animated-fade-in" style={{ paddingBottom: '3rem' }}>
      {/* CSS style injection for toggle switches */}
      <style>{`
        .settings-container {
          display: grid;
          grid-template-columns: 200px 1fr;
          gap: 2.5rem;
          margin-top: 1rem;
        }
        @media (max-width: 768px) {
          .settings-container {
            grid-template-columns: 1fr;
            gap: 1.5rem;
          }
        }
        .settings-tab-btn {
          display: flex;
          align-items: center;
          gap: 0.75rem;
          width: 100%;
          padding: 0.6rem 0.85rem;
          background: transparent;
          border: none;
          border-radius: 8px;
          color: var(--text-muted);
          font-weight: 600;
          font-size: 0.85rem;
          cursor: pointer;
          transition: var(--transition-smooth);
          text-align: left;
        }
        .settings-tab-btn.active {
          background-color: var(--bg-hover);
          color: var(--text-title);
        }
        .settings-tab-btn:hover:not(.active) {
          background-color: rgba(255, 255, 255, 0.03);
          color: var(--text-title);
        }
        .switch {
          position: relative;
          display: inline-block;
          width: 38px;
          height: 20px;
          flex-shrink: 0;
        }
        .switch input {
          opacity: 0;
          width: 0;
          height: 0;
        }
        .slider {
          position: absolute;
          cursor: pointer;
          inset: 0;
          background-color: var(--border-subtle);
          transition: 0.2s;
          border-radius: 20px;
        }
        .slider:before {
          position: absolute;
          content: "";
          height: 14px;
          width: 14px;
          left: 3px;
          bottom: 3px;
          background-color: #fff;
          transition: 0.2s;
          border-radius: 50%;
        }
        input:checked + .slider {
          background-color: var(--accent-primary);
        }
        input:checked + .slider:before {
          transform: translateX(18px);
        }
        .settings-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 1rem 1.25rem;
          border-bottom: 1px solid var(--border-subtle);
        }
        .settings-row:last-child {
          border-bottom: none;
        }
      `}</style>

      {/* Settings Header with close (X) button */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.75rem',
          marginBottom: '1.5rem',
          borderBottom: '1px solid var(--border-subtle)',
          paddingBottom: '1rem',
        }}
      >
        <button
          style={{
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            color: 'var(--text-title)',
            display: 'flex',
            alignItems: 'center',
            padding: '0.2rem',
          }}
          onClick={() => window.history.back()}
          title="Back"
        >
          <X size={18} />
        </button>
        <h2 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 800 }}>Settings</h2>
      </div>

      <div className="settings-container">
        {/* Left Side: Navigation Links */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
          <button
            className={`settings-tab-btn ${activeCategory === 'account' ? 'active' : ''}`}
            onClick={() => setActiveCategory('account')}
          >
            <User size={16} />
            <span>Account</span>
          </button>
          <button
            className={`settings-tab-btn ${activeCategory === 'privacy' ? 'active' : ''}`}
            onClick={() => setActiveCategory('privacy')}
          >
            <Lock size={16} />
            <span>Privacy</span>
          </button>
          <button
            className={`settings-tab-btn ${activeCategory === 'notification' ? 'active' : ''}`}
            onClick={() => setActiveCategory('notification')}
          >
            <Bell size={16} />
            <span>Notification</span>
          </button>
          <button
            className={`settings-tab-btn ${activeCategory === 'appearance' ? 'active' : ''}`}
            onClick={() => setActiveCategory('appearance')}
          >
            <Eye size={16} />
            <span>Appearance</span>
          </button>
          <button
            className={`settings-tab-btn ${activeCategory === 'automation' ? 'active' : ''}`}
            onClick={() => setActiveCategory('automation')}
          >
            <Cpu size={16} />
            <span>Automation</span>
          </button>
        </div>

        {/* Right Side: Settings Content Pane */}
        <div>
          {activeCategory === 'account' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
              <div>
                <OrgProfileForm />
              </div>
              <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: '2rem' }}>
                <BusinessProfileForm />
              </div>
              <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: '2rem' }}>
                <GmailConnect />
              </div>
              <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: '2rem' }}>
                <BankConnect />
              </div>
              <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: '2rem' }}>
                <XeroConnect />
              </div>
              <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: '2rem' }}>
                <PayerBankDetails />
              </div>
              <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: '2rem' }}>
                <ApiKeys />
              </div>
              <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: '2rem' }}>
                <h2
                  style={{
                    fontSize: '1.15rem',
                    marginBottom: '1rem',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.35rem',
                  }}
                >
                  <Shield size={18} style={{ color: 'var(--text-muted)' }} />
                  Team & Security
                </h2>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                  <Link
                    to="/settings/team"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '0.85rem 1rem',
                      background: 'var(--bg-card)',
                      border: '1px solid var(--border-subtle)',
                      borderRadius: '8px',
                      color: 'var(--text-title)',
                      fontWeight: 600,
                      fontSize: '0.825rem',
                      textDecoration: 'none',
                      transition: 'var(--transition-smooth)',
                    }}
                  >
                    <span>Team members &amp; roles</span>
                    <ChevronRight size={14} style={{ color: 'var(--text-muted)' }} />
                  </Link>
                  <Link
                    to="/settings/audit-log"
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '0.85rem 1rem',
                      background: 'var(--bg-card)',
                      border: '1px solid var(--border-subtle)',
                      borderRadius: '8px',
                      color: 'var(--text-title)',
                      fontWeight: 600,
                      fontSize: '0.825rem',
                      textDecoration: 'none',
                      transition: 'var(--transition-smooth)',
                    }}
                  >
                    <span>Audit log</span>
                    <ChevronRight size={14} style={{ color: 'var(--text-muted)' }} />
                  </Link>
                </div>
              </div>
            </div>
          )}

          {activeCategory === 'privacy' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <h3 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 800 }}>Privacy</h3>
              <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', lineHeight: 1.5 }}>
                Each organisation's records are kept separate by database access rules, so only
                people who have been given access to an organisation can see its books. Looplet has
                no advertising or social-media tracking, and there are no data-sharing switches to
                set here.
              </p>
            </div>
          )}

          {activeCategory === 'notification' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
              <h3 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 800 }}>
                Notification settings
              </h3>
              <ProductEmailConsent />
            </div>
          )}

          {activeCategory === 'appearance' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <h3 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 800 }}>Appearance</h3>
              <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', lineHeight: 1.5 }}>
                Appearance settings are controlled globally in the top header. Switch themes
                (light/dark mode) using the sun/moon icon.
              </p>
            </div>
          )}

          {activeCategory === 'automation' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
              <div
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
              >
                <h3 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 800 }}>
                  Confidence policies
                </h3>
                <button
                  onClick={() => setAddingPolicy((v) => !v)}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '0.4rem',
                    padding: '0.45rem 0.9rem',
                    background: 'var(--accent-primary)',
                    border: 'none',
                    borderRadius: '6px',
                    color: '#fff',
                    fontWeight: 600,
                    fontSize: '0.8rem',
                    cursor: 'pointer',
                  }}
                >
                  <Plus size={14} />
                  Add policy
                </button>
              </div>
              <p
                style={{
                  color: 'var(--text-muted)',
                  fontSize: '0.825rem',
                  lineHeight: 1.5,
                  margin: 0,
                }}
              >
                Override the default confidence band for a source/task combination. The most
                specific active policy wins over the AI-computed band.
              </p>

              {policyError && (
                <div style={{ color: 'var(--color-error, var(--text-danger))', fontSize: '0.8rem' }}>
                  {policyError}
                </div>
              )}

              {addingPolicy && (
                <div
                  className="card"
                  style={{
                    padding: '1rem',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.75rem',
                  }}
                >
                  <div style={{ fontWeight: 700, fontSize: '0.85rem' }}>New policy</div>
                  <div
                    style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.75rem' }}
                  >
                    <div>
                      <label
                        style={{
                          fontSize: '0.75rem',
                          color: 'var(--text-muted)',
                          display: 'block',
                          marginBottom: '0.25rem',
                        }}
                      >
                        Source kind
                      </label>
                      <select
                        value={newPolicy.source_kind}
                        onChange={(e) =>
                          setNewPolicy((p) => ({
                            ...p,
                            source_kind: e.target.value as DecisionSourceKind,
                          }))
                        }
                        style={{
                          width: '100%',
                          padding: '0.4rem 0.6rem',
                          background: 'var(--bg-input)',
                          border: '1px solid var(--border-subtle)',
                          borderRadius: '6px',
                          color: 'var(--text-title)',
                          fontSize: '0.8rem',
                        }}
                      >
                        {SOURCE_KIND_OPTIONS.map((k) => (
                          <option key={k} value={k}>
                            {k}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label
                        style={{
                          fontSize: '0.75rem',
                          color: 'var(--text-muted)',
                          display: 'block',
                          marginBottom: '0.25rem',
                        }}
                      >
                        Task type
                      </label>
                      <select
                        value={newPolicy.task_type}
                        onChange={(e) =>
                          setNewPolicy((p) => ({ ...p, task_type: e.target.value as DecisionKind }))
                        }
                        style={{
                          width: '100%',
                          padding: '0.4rem 0.6rem',
                          background: 'var(--bg-input)',
                          border: '1px solid var(--border-subtle)',
                          borderRadius: '6px',
                          color: 'var(--text-title)',
                          fontSize: '0.8rem',
                        }}
                      >
                        {TASK_TYPE_OPTIONS.map((t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label
                        style={{
                          fontSize: '0.75rem',
                          color: 'var(--text-muted)',
                          display: 'block',
                          marginBottom: '0.25rem',
                        }}
                      >
                        Policy band
                      </label>
                      <select
                        value={newPolicy.policy}
                        onChange={(e) =>
                          setNewPolicy((p) => ({
                            ...p,
                            policy: e.target.value as AutomationConfidence,
                          }))
                        }
                        style={{
                          width: '100%',
                          padding: '0.4rem 0.6rem',
                          background: 'var(--bg-input)',
                          border: '1px solid var(--border-subtle)',
                          borderRadius: '6px',
                          color: 'var(--text-title)',
                          fontSize: '0.8rem',
                        }}
                      >
                        {CONFIDENCE_OPTIONS.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
                    <button
                      onClick={() => setAddingPolicy(false)}
                      style={{
                        padding: '0.4rem 0.8rem',
                        background: 'transparent',
                        border: '1px solid var(--border-subtle)',
                        borderRadius: '6px',
                        color: 'var(--text-muted)',
                        fontSize: '0.8rem',
                        cursor: 'pointer',
                      }}
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleAddPolicy}
                      style={{
                        padding: '0.4rem 0.8rem',
                        background: 'var(--accent-primary)',
                        border: 'none',
                        borderRadius: '6px',
                        color: '#fff',
                        fontWeight: 600,
                        fontSize: '0.8rem',
                        cursor: 'pointer',
                      }}
                    >
                      Save
                    </button>
                  </div>
                </div>
              )}

              {policiesLoading ? (
                <div
                  style={{ display: 'grid', gap: '0.5rem' }}
                  aria-busy="true"
                  aria-label="Loading automation policies"
                >
                  <SkeletonLine width="60%" height={12} />
                  <SkeletonLine width="45%" height={12} />
                </div>
              ) : policies.length === 0 ? (
                <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                  No policies yet. The AI-computed confidence band applies to all decisions.
                </div>
              ) : (
                <div className="card" style={{ padding: '0.5rem 0' }}>
                  {policies.map((p) => (
                    <div
                      key={p.id}
                      className="settings-row"
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                      }}
                    >
                      <div>
                        <div
                          style={{
                            fontWeight: 600,
                            fontSize: '0.85rem',
                            color: 'var(--text-title)',
                          }}
                        >
                          {p.source_kind} / {p.task_type}
                          {p.supplier_id && (
                            <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>
                              {' '}
                              · supplier {p.supplier_id.slice(0, 8)}…
                            </span>
                          )}
                        </div>
                        <div
                          style={{
                            fontSize: '0.75rem',
                            color: 'var(--text-muted)',
                            marginTop: '0.1rem',
                          }}
                        >
                          <strong>{p.policy}</strong>
                          {p.valid_until
                            ? ` · expires ${new Date(p.valid_until).toLocaleDateString()}`
                            : ' · no expiry'}
                        </div>
                      </div>
                      <button
                        onClick={() => handleDeletePolicy(p.id)}
                        title="Delete policy"
                        style={{
                          background: 'transparent',
                          border: 'none',
                          cursor: 'pointer',
                          color: 'var(--text-muted)',
                          padding: '0.25rem',
                        }}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Informative card info */}
      <div
        className="card"
        style={{
          marginTop: '2.5rem',
          background: 'var(--bg-hover)',
          border: '1px dashed var(--border-subtle)',
          padding: '1.25rem',
          display: 'flex',
          gap: '0.75rem',
          alignItems: 'flex-start',
        }}
      >
        <Info
          size={16}
          style={{ flexShrink: 0, color: 'var(--text-link)', marginTop: '2px' }}
        />
        <div style={{ fontSize: '0.825rem', color: 'var(--text-muted)', lineHeight: '1.5' }}>
          <span
            style={{
              fontWeight: 600,
              color: 'var(--text-title)',
              display: 'block',
              marginBottom: '0.25rem',
            }}
          >
            Accounting Preferences
          </span>
          Looplet loads each organisation's settings when you switch to it. Tax due-date reminders
          and bill-reading prompts follow the organisation you are working in.
        </div>
      </div>
    </section>
  );
}
