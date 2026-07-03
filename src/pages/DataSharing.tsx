import { Link } from 'react-router-dom';

// The destination for Basiq's dashboard "Manage Consent URL" field (Flow tab)
// — shown to consumers inside Basiq's own "Manage your data sharing" section
// per their go-live checklist. Plain-language, no auth-gated content, so it
// reads fine whether the viewer arrived from inside the app or from a link
// Basiq surfaces elsewhere.
export function DataSharingPage() {
  return (
    <section
      className="animated-fade-in"
      style={{ display: 'grid', gap: '1.25rem', maxWidth: '760px' }}
    >
      <div>
        <h1 style={{ margin: 0 }}>Managing your bank data sharing</h1>
        <p style={{ color: 'var(--text-muted)', marginTop: '0.5rem' }}>
          Looplet Accounting connects to your bank through{' '}
          <a href="https://basiq.io" target="_blank" rel="noreferrer">
            Basiq
          </a>
          , an accredited Open Banking (Consumer Data Right) provider. Basiq never gives Looplet
          your online banking password — only read access to account and transaction data you
          approve.
        </p>
      </div>

      <article className="card" style={{ display: 'grid', gap: '0.6rem' }}>
        <h2 style={{ margin: 0, fontSize: '1rem' }}>What we access</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', lineHeight: 1.6, margin: 0 }}>
          Account details and transaction history for the accounts you choose to connect. This is
          used to reconcile bank transactions against bills and invoices, and to keep your books up
          to date automatically.
        </p>
      </article>

      <article className="card" style={{ display: 'grid', gap: '0.6rem' }}>
        <h2 style={{ margin: 0, fontSize: '1rem' }}>How long we keep it</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', lineHeight: 1.6, margin: 0 }}>
          Your bank consent is valid for up to 12 months, after which you'll be asked to re-approve
          access. Ingested transaction and banking records are retained per Australian
          record-keeping requirements (generally 5 years for financial records, 7 years for
          payroll-related records) independent of whether the live bank connection is still active.
        </p>
      </article>

      <article className="card" style={{ display: 'grid', gap: '0.6rem' }}>
        <h2 style={{ margin: 0, fontSize: '1rem' }}>Disconnecting a bank</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', lineHeight: 1.6, margin: 0 }}>
          You can revoke access at any time from{' '}
          <Link to="/settings">Settings → Bank accounts</Link> by clicking Disable on a connection.
          This both stops future syncing in Looplet and revokes the underlying consent with Basiq —
          it does not delete transactions already imported into your books.
        </p>
      </article>

      <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>
        Questions about how your data is handled? Contact your account owner, or reach Basiq
        directly at <a href="mailto:hello@basiq.io">hello@basiq.io</a>.
      </p>
    </section>
  );
}
