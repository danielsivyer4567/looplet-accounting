import { GmailConnect } from '@/components/settings/GmailConnect';

export function SettingsPage() {
  return (
    <section>
      <h1>Settings</h1>
      <ul style={{ color: '#888', lineHeight: 1.8, marginBottom: '2rem' }}>
        <li>Organisation profile + ABN</li>
        <li>Overhead profile (per ADR 0002)</li>
        <li>Tax set-aside % (per ADR 0003)</li>
        <li>BAS quarter / fiscal year</li>
        <li>Xero connection (Phase 3)</li>
        <li>Team members + invitations</li>
      </ul>
      <GmailConnect />
    </section>
  );
}
