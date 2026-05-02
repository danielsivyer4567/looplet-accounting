import { OrgProfileForm } from '@/components/settings/OrgProfile';
import { GmailConnect } from '@/components/settings/GmailConnect';
import { BankConnect } from '@/components/settings/BankConnect';

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
        <h2 style={{ fontSize: 16, marginBottom: 8 }}>Coming next</h2>
        <ul style={{ color: '#888', fontSize: 13, lineHeight: 1.8 }}>
          <li>Xero connection (push bills as ACCPAY, push invoices as ACCREC, pull payments)</li>
          <li>Team members + role-based access (owner, accountant, employee)</li>
          <li>Audit log of every change</li>
          <li>Notification preferences (overdue invoices, BAS due reminders, OCR review queue)</li>
        </ul>
      </div>
    </section>
  );
}
