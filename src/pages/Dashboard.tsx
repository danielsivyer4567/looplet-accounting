import { useAuth } from '@/contexts/AuthContext';

export function DashboardPage() {
  const { user, signOut } = useAuth();

  return (
    <div style={{ padding: '2rem' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>Looplet Accounting</h1>
        <div>
          <span style={{ marginRight: '1rem' }}>{user?.email}</span>
          <button onClick={() => signOut()} style={{ padding: '0.5rem 1rem' }}>
            Sign out
          </button>
        </div>
      </header>
      <main>
        <p>
          Welcome. The dashboard is empty for now — bills, jobs, and per-job profit views land in
          Phase 4 of the roadmap.
        </p>
        <p>
          Schema is live on <code>dxoikltymmknxqpkpyhi</code>. Run{' '}
          <code>npm run supabase:types</code> to generate strong types from the live schema, then
          start wiring queries.
        </p>
      </main>
    </div>
  );
}
