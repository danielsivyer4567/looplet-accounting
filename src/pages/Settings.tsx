import { useState } from 'react';
import { Link } from 'react-router-dom';
import { OrgProfileForm } from '@/components/settings/OrgProfile';
import { BusinessProfileForm } from '@/components/settings/BusinessProfileForm';
import { GmailConnect } from '@/components/settings/GmailConnect';
import { BankConnect } from '@/components/settings/BankConnect';
import { XeroConnect } from '@/components/settings/XeroConnect';
import { PayerBankDetails } from '@/components/settings/PayerBankDetails';
import { InviteAccountant } from '@/components/settings/InviteAccountant';
import { ApiKeys } from '@/components/settings/ApiKeys';
import { User, Lock, Bell, Eye, Shield, ChevronRight, Info, X } from 'lucide-react';

type SettingsCategory = 'account' | 'privacy' | 'notification' | 'appearance';

export function SettingsPage() {
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
                <InviteAccountant />
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
