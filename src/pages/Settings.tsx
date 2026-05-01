export function SettingsPage() {
  return (
    <section>
      <h1>Settings</h1>
      <ul style={{ color: '#888', lineHeight: 1.8 }}>
        <li>Organisation profile + ABN</li>
        <li>Overhead profile (per ADR 0002)</li>
        <li>Tax set-aside % (per ADR 0003)</li>
        <li>BAS quarter / fiscal year</li>
        <li>Xero connection (Phase 3)</li>
        <li>Team members + invitations</li>
      </ul>
      <p style={{ color: '#666', fontSize: 14 }}>All deferred to Phase 4 of the roadmap.</p>
    </section>
  );
}
