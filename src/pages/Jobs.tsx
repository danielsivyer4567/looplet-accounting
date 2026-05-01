import { useOrg } from '@/contexts/OrgContext';

export function JobsPage() {
  const { currentOrg } = useOrg();
  return (
    <section>
      <h1>Jobs</h1>
      {!currentOrg ? (
        <p style={{ color: '#888' }}>Pick an organisation to see jobs.</p>
      ) : (
        <p style={{ color: '#888' }}>
          Jobs list for <strong>{currentOrg.name}</strong>. The per-job ledger and "what's really
          yours" view land in Phase 4.
        </p>
      )}
    </section>
  );
}
