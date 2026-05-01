import { useOrg } from '@/contexts/OrgContext';

export function BillsPage() {
  const { currentOrg } = useOrg();
  return (
    <section>
      <h1>Bills</h1>
      {!currentOrg ? (
        <p style={{ color: '#888' }}>Pick an organisation to see bills.</p>
      ) : (
        <div>
          <p style={{ color: '#888' }}>
            Bills inbox for <strong>{currentOrg.name}</strong>. Empty until OCR/Xero ports land
            (Phase 3 of the roadmap).
          </p>
          <p style={{ color: '#666', fontSize: 14 }}>
            Three intake lanes will populate this list: manual upload, contractor uploads via
            Airparser, and Gmail Pub/Sub email scrape.
          </p>
        </div>
      )}
    </section>
  );
}
