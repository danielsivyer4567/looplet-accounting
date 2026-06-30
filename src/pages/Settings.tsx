import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { OrgProfileForm } from '@/components/settings/OrgProfile';
import { BusinessProfileForm } from '@/components/settings/BusinessProfileForm';
import { GmailConnect } from '@/components/settings/GmailConnect';
import { BankConnect } from '@/components/settings/BankConnect';
import { XeroConnect } from '@/components/settings/XeroConnect';
import { PayerBankDetails } from '@/components/settings/PayerBankDetails';
import { User, Lock, Bell, Eye, Shield, ChevronRight, Info, X, Cpu, Trash2, Plus } from 'lucide-react';
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

export function SettingsPage() {
  const { currentOrg } = useOrg();
  const [activeCategory, setActiveCategory] = useState<SettingsCategory>('notification');
  const [notifications, setNotifications] = useState({
    emails: true,
    pushes: true,
    inApp: true,
    social: true,
    thirdParty: false,
    commodities: true,
    crypto: true,
  });

  const toggleNotification = (key: keyof typeof notifications) => {
    setNotifications((prev) => ({ ...prev, [key]: !prev[key] }));
  };

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
              <h3 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 800 }}>Privacy settings</h3>
              <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', lineHeight: 1.5 }}>
                Your data is strictly isolated within tenant containers and encrypted at rest.
                Select options below to configure audit levels.
              </p>
              <div className="card" style={{ padding: '0.5rem 0' }}>
                <div className="settings-row">
                  <div>
                    <div
                      style={{ fontWeight: 600, fontSize: '0.85rem', color: 'var(--text-title)' }}
                    >
                      Strict Tenant Isolation
                    </div>
                    <div
                      style={{
                        fontSize: '0.75rem',
                        color: 'var(--text-muted)',
                        marginTop: '0.15rem',
                      }}
                    >
                      Verify row-level security policies on every API call.
                    </div>
                  </div>
                  <label className="switch">
                    <input type="checkbox" defaultChecked disabled />
                    <span className="slider" />
                  </label>
                </div>
                <div className="settings-row">
                  <div>
                    <div
                      style={{ fontWeight: 600, fontSize: '0.85rem', color: 'var(--text-title)' }}
                    >
                      Anonymized Audits
                    </div>
                    <div
                      style={{
                        fontSize: '0.75rem',
                        color: 'var(--text-muted)',
                        marginTop: '0.15rem',
                      }}
                    >
                      Anonymize financial metrics in aggregate performance logs.
                    </div>
                  </div>
                  <label className="switch">
                    <input type="checkbox" />
                    <span className="slider" />
                  </label>
                </div>
              </div>
            </div>
          )}

          {activeCategory === 'notification' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
              <h3 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 800 }}>
                Notification settings
              </h3>

              {/* Marketing Group */}
              <div>
                <span
                  style={{
                    display: 'block',
                    fontSize: '0.75rem',
                    color: 'var(--text-muted)',
                    fontWeight: 600,
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                    marginBottom: '0.5rem',
                  }}
                >
                  Marketing
                </span>
                <div className="card" style={{ padding: '0.5rem 0' }}>
                  <div className="settings-row">
                    <div>
                      <div
                        style={{ fontWeight: 600, fontSize: '0.85rem', color: 'var(--text-title)' }}
                      >
                        Personalized emails
                      </div>
                      <div
                        style={{
                          fontSize: '0.75rem',
                          color: 'var(--text-muted)',
                          marginTop: '0.15rem',
                          lineHeight: 1.4,
                        }}
                      >
                        I am happy to receive emails about Revolut products, services and offers
                        that may interest me
                      </div>
                    </div>
                    <label className="switch">
                      <input
                        type="checkbox"
                        checked={notifications.emails}
                        onChange={() => toggleNotification('emails')}
                      />
                      <span className="slider" />
                    </label>
                  </div>

                  <div className="settings-row">
                    <div>
                      <div
                        style={{ fontWeight: 600, fontSize: '0.85rem', color: 'var(--text-title)' }}
                      >
                        Personalized pushes
                      </div>
                      <div
                        style={{
                          fontSize: '0.75rem',
                          color: 'var(--text-muted)',
                          marginTop: '0.15rem',
                          lineHeight: 1.4,
                        }}
                      >
                        I am happy to receive push notifications about Revolut products, services
                        and offers that may interest me
                      </div>
                    </div>
                    <label className="switch">
                      <input
                        type="checkbox"
                        checked={notifications.pushes}
                        onChange={() => toggleNotification('pushes')}
                      />
                      <span className="slider" />
                    </label>
                  </div>

                  <div className="settings-row">
                    <div>
                      <div
                        style={{ fontWeight: 600, fontSize: '0.85rem', color: 'var(--text-title)' }}
                      >
                        Personalized in-app recommendations
                      </div>
                      <div
                        style={{
                          fontSize: '0.75rem',
                          color: 'var(--text-muted)',
                          marginTop: '0.15rem',
                          lineHeight: 1.4,
                        }}
                      >
                        I'm happy to see recommendations about Revolut products, services and offers
                        that may interest me
                      </div>
                    </div>
                    <label className="switch">
                      <input
                        type="checkbox"
                        checked={notifications.inApp}
                        onChange={() => toggleNotification('inApp')}
                      />
                      <span className="slider" />
                    </label>
                  </div>

                  <div className="settings-row">
                    <div>
                      <div
                        style={{ fontWeight: 600, fontSize: '0.85rem', color: 'var(--text-title)' }}
                      >
                        Social media and advertising platforms
                      </div>
                      <div
                        style={{
                          fontSize: '0.75rem',
                          color: 'var(--text-muted)',
                          marginTop: '0.15rem',
                          lineHeight: 1.4,
                        }}
                      >
                        I'm happy for Revolut to share my name, email address, and app events with
                        social media platforms to allow Revolut to advertise to me and others like
                        me
                      </div>
                    </div>
                    <label className="switch">
                      <input
                        type="checkbox"
                        checked={notifications.social}
                        onChange={() => toggleNotification('social')}
                      />
                      <span className="slider" />
                    </label>
                  </div>
                </div>
              </div>

              {/* Promotions Group */}
              <div>
                <span
                  style={{
                    display: 'block',
                    fontSize: '0.75rem',
                    color: 'var(--text-muted)',
                    fontWeight: 600,
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                    marginBottom: '0.5rem',
                  }}
                >
                  Promotions
                </span>
                <div className="card" style={{ padding: '0.5rem 0' }}>
                  <div className="settings-row">
                    <div>
                      <div
                        style={{ fontWeight: 600, fontSize: '0.85rem', color: 'var(--text-title)' }}
                      >
                        Third party promotions
                      </div>
                      <div
                        style={{
                          fontSize: '0.75rem',
                          color: 'var(--text-muted)',
                          marginTop: '0.15rem',
                          lineHeight: 1.4,
                        }}
                      >
                        I want to receive notifications about promotions from Revolut partners
                      </div>
                    </div>
                    <label className="switch">
                      <input
                        type="checkbox"
                        checked={notifications.thirdParty}
                        onChange={() => toggleNotification('thirdParty')}
                      />
                      <span className="slider" />
                    </label>
                  </div>
                </div>
              </div>

              {/* Commodities Group */}
              <div>
                <span
                  style={{
                    display: 'block',
                    fontSize: '0.75rem',
                    color: 'var(--text-muted)',
                    fontWeight: 600,
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                    marginBottom: '0.5rem',
                  }}
                >
                  Commodities
                </span>
                <div className="card" style={{ padding: '0.5rem 0' }}>
                  <div className="settings-row">
                    <div>
                      <div
                        style={{ fontWeight: 600, fontSize: '0.85rem', color: 'var(--text-title)' }}
                      >
                        Commodities volatility alerts
                      </div>
                      <div
                        style={{
                          fontSize: '0.75rem',
                          color: 'var(--text-muted)',
                          marginTop: '0.15rem',
                          lineHeight: 1.4,
                        }}
                      >
                        Notify me automatically whenever the price of precious metals makes a
                        significant move
                      </div>
                    </div>
                    <label className="switch">
                      <input
                        type="checkbox"
                        checked={notifications.commodities}
                        onChange={() => toggleNotification('commodities')}
                      />
                      <span className="slider" />
                    </label>
                  </div>
                </div>
              </div>

              {/* Cryptocurrencies Group */}
              <div>
                <span
                  style={{
                    display: 'block',
                    fontSize: '0.75rem',
                    color: 'var(--text-muted)',
                    fontWeight: 600,
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                    marginBottom: '0.5rem',
                  }}
                >
                  Cryptocurrencies
                </span>
                <div className="card" style={{ padding: '0.5rem 0' }}>
                  <div className="settings-row">
                    <div>
                      <div
                        style={{ fontWeight: 600, fontSize: '0.85rem', color: 'var(--text-title)' }}
                      >
                        Crypto volatility alerts
                      </div>
                      <div
                        style={{
                          fontSize: '0.75rem',
                          color: 'var(--text-muted)',
                          marginTop: '0.15rem',
                          lineHeight: 1.4,
                        }}
                      >
                        Notify me automatically whenever the price of cryptocurrency makes a
                        significant move
                      </div>
                    </div>
                    <label className="switch">
                      <input
                        type="checkbox"
                        checked={notifications.crypto}
                        onChange={() => toggleNotification('crypto')}
                      />
                      <span className="slider" />
                    </label>
                  </div>
                </div>
              </div>
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
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
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
              <p style={{ color: 'var(--text-muted)', fontSize: '0.825rem', lineHeight: 1.5, margin: 0 }}>
                Override the default confidence band for a source/task combination.
                The most specific active policy wins over the AI-computed band.
              </p>

              {policyError && (
                <div style={{ color: 'var(--color-error, #ef4444)', fontSize: '0.8rem' }}>
                  {policyError}
                </div>
              )}

              {addingPolicy && (
                <div
                  className="card"
                  style={{ padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}
                >
                  <div style={{ fontWeight: 700, fontSize: '0.85rem' }}>New policy</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '0.75rem' }}>
                    <div>
                      <label style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'block', marginBottom: '0.25rem' }}>
                        Source kind
                      </label>
                      <select
                        value={newPolicy.source_kind}
                        onChange={(e) =>
                          setNewPolicy((p) => ({ ...p, source_kind: e.target.value as DecisionSourceKind }))
                        }
                        style={{
                          width: '100%', padding: '0.4rem 0.6rem',
                          background: 'var(--bg-input)', border: '1px solid var(--border-subtle)',
                          borderRadius: '6px', color: 'var(--text-title)', fontSize: '0.8rem',
                        }}
                      >
                        {SOURCE_KIND_OPTIONS.map((k) => (
                          <option key={k} value={k}>{k}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'block', marginBottom: '0.25rem' }}>
                        Task type
                      </label>
                      <select
                        value={newPolicy.task_type}
                        onChange={(e) =>
                          setNewPolicy((p) => ({ ...p, task_type: e.target.value as DecisionKind }))
                        }
                        style={{
                          width: '100%', padding: '0.4rem 0.6rem',
                          background: 'var(--bg-input)', border: '1px solid var(--border-subtle)',
                          borderRadius: '6px', color: 'var(--text-title)', fontSize: '0.8rem',
                        }}
                      >
                        {TASK_TYPE_OPTIONS.map((t) => (
                          <option key={t} value={t}>{t}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label style={{ fontSize: '0.75rem', color: 'var(--text-muted)', display: 'block', marginBottom: '0.25rem' }}>
                        Policy band
                      </label>
                      <select
                        value={newPolicy.policy}
                        onChange={(e) =>
                          setNewPolicy((p) => ({ ...p, policy: e.target.value as AutomationConfidence }))
                        }
                        style={{
                          width: '100%', padding: '0.4rem 0.6rem',
                          background: 'var(--bg-input)', border: '1px solid var(--border-subtle)',
                          borderRadius: '6px', color: 'var(--text-title)', fontSize: '0.8rem',
                        }}
                      >
                        {CONFIDENCE_OPTIONS.map((c) => (
                          <option key={c} value={c}>{c}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
                    <button
                      onClick={() => setAddingPolicy(false)}
                      style={{
                        padding: '0.4rem 0.8rem', background: 'transparent',
                        border: '1px solid var(--border-subtle)', borderRadius: '6px',
                        color: 'var(--text-muted)', fontSize: '0.8rem', cursor: 'pointer',
                      }}
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleAddPolicy}
                      style={{
                        padding: '0.4rem 0.8rem', background: 'var(--accent-primary)',
                        border: 'none', borderRadius: '6px',
                        color: '#fff', fontWeight: 600, fontSize: '0.8rem', cursor: 'pointer',
                      }}
                    >
                      Save
                    </button>
                  </div>
                </div>
              )}

              {policiesLoading ? (
                <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>Loading…</div>
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
                      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
                    >
                      <div>
                        <div style={{ fontWeight: 600, fontSize: '0.85rem', color: 'var(--text-title)' }}>
                          {p.source_kind} / {p.task_type}
                          {p.supplier_id && (
                            <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>
                              {' '}· supplier {p.supplier_id.slice(0, 8)}…
                            </span>
                          )}
                        </div>
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.1rem' }}>
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
                          background: 'transparent', border: 'none',
                          cursor: 'pointer', color: 'var(--text-muted)',
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
          style={{ flexShrink: 0, color: 'var(--accent-primary)', marginTop: '2px' }}
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
          Looplet syncs organizations dynamically. BAS submission alerts, tax deadlines, and OCR
          scanning cues are loaded contextually based on active company setups.
        </div>
      </div>
    </section>
  );
}
