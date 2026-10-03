import { Link } from 'react-router-dom';

// Explains how bank-feed data reaches Looplet and how to stop it. Linked from Settings → Bank accounts. Plain
// language, no auth-gated content, so it reads the same whether the viewer is signed in or not.
export function DataSharingPage() {
  return (
    <section
      className="animated-fade-in"
      style={{ display: 'grid', gap: '1.25rem', maxWidth: '760px' }}
    >
      <div>
        <h1 style={{ margin: 0 }}>Managing your bank data sharing</h1>
        <p style={{ color: 'var(--text-muted)', marginTop: '0.5rem' }}>
          Looplet Accounting reads bank transactions through{' '}
          <a href="https://redbark.com" target="_blank" rel="noreferrer">
            Redbark
          </a>
          , a bank-data service. Your bank is connected to Redbark in the business&apos;s own
          Redbark account, not inside Looplet, and Looplet never sees your online banking password.
          An admin of your organisation then chooses which of those accounts to link here, and from
          which date.
        </p>
      </div>

      <article className="card" style={{ display: 'grid', gap: '0.6rem' }}>
        <h2 style={{ margin: 0, fontSize: '1rem' }}>What we access</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', lineHeight: 1.6, margin: 0 }}>
          For each linked account: its name, the last digits of its number, its balance, and its
          posted transactions dated on or after the import-from date chosen when it was linked.
          Pending transactions are not imported. This is used to reconcile bank transactions against
          bills and invoices and to keep your books up to date.
        </p>
      </article>

      <article className="card" style={{ display: 'grid', gap: '0.6rem' }}>
        <h2 style={{ margin: 0, fontSize: '1rem' }}>How long we keep it</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', lineHeight: 1.6, margin: 0 }}>
          The consent that lets Redbark read your bank, including when it expires, is managed in
          your Redbark account. Ingested transaction and banking records are retained per Australian
          record-keeping requirements (generally 5 years for financial records, 7 years for
          payroll-related records) independent of whether the live bank connection is still active.
        </p>
      </article>

      <article className="card" style={{ display: 'grid', gap: '0.6rem' }}>
        <h2 style={{ margin: 0, fontSize: '1rem' }}>Stopping a bank feed</h2>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.9rem', lineHeight: 1.6, margin: 0 }}>
          An admin can stop a feed from <Link to="/settings">Settings → Bank accounts</Link> by
          clicking Disable feed. Looplet then stops importing from that connection and keeps the
          transactions already imported. It does not change the connection in Redbark: to stop
          Redbark reading your bank, remove the connection in your Redbark account.
        </p>
      </article>

      <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>
        Questions about how your data is handled? Contact your account owner. For the bank
        connection itself, use your Redbark account.
      </p>
    </section>
  );
}
