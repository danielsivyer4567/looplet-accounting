import { Link } from 'react-router-dom';
import { OrgProfileForm } from '@/components/settings/OrgProfile';
import { GmailConnect } from '@/components/settings/GmailConnect';
import { BankConnect } from '@/components/settings/BankConnect';
import { XeroConnect } from '@/components/settings/XeroConnect';
import { PayerBankDetails } from '@/components/settings/PayerBankDetails';

export function SettingsPage() {
  return (
    <section>
      <h1>Settings</h1>

      <OrgProfileForm />

      <div style={{ marginTop: '2.5rem', borderTop: '1px solid #2a2a2a', paddingTop: '1.5rem' }}>
        <GmailConnect />
      </div>

      <div style={{ marginTop: '2.5rem', borderTop: '1px solid #2a2a2a', paddingTop: '1.5rem' }}>
        <BankConnect />
      </div>

      <div style={{ marginTop: '2.5rem', borderTop: '1px solid #2a2a2a', paddingTop: '1.5rem' }}>
        <XeroConnect />
      </div>

      <div style={{ marginTop: '2.5rem', borderTop: '1px solid #2a2a2a', paddingTop: '1.5rem' }}>
        <PayerBankDetails />
      </div>

      <div style={{ marginTop: '2.5rem', borderTop: '1px solid #2a2a2a', paddingTop: '1.5rem' }}>
        <h2 style={{ fontSize: 16, marginBottom: 12 }}>Team &amp; Security</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
          <Link
            to="/settings/team"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.4rem',
              color: '#86c7a3',
              fontSize: 13,
              textDecoration: 'none',
            }}
          >
            Team members &amp; roles
            <span style={{ color: '#555' }}>&rarr;</span>
          </Link>
          <Link
            to="/settings/audit-log"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '0.4rem',
              color: '#86c7a3',
              fontSize: 13,
              textDecoration: 'none',
            }}
          >
            Audit log
            <span style={{ color: '#555' }}>&rarr;</span>
          </Link>
        </div>
      </div>

      <div style={{ marginTop: '2.5rem', borderTop: '1px solid #2a2a2a', paddingTop: '1.5rem' }}>
        <h2 style={{ fontSize: 16, marginBottom: 8 }}>Coming next</h2>
        <ul style={{ color: '#888', fontSize: 13, lineHeight: 1.8 }}>
          <li>Notification preferences (overdue invoices, BAS due reminders, OCR review queue)</li>
        </ul>
      </div>
    </section>
  );
}
