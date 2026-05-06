import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useOrg } from '@/contexts/OrgContext';
import { useJobs } from '@/hooks/useJobs';
import type { JobStatus } from '@/hooks/useJobs';
import { supabase } from '@/lib/supabase';

const statusColors: Record<JobStatus, string> = {
  draft: '#888',
  active: '#86c7a3',
  paused: '#d2c886',
  completed: '#7799d6',
  cancelled: '#555',
};

function getBillCount(val: [{ count: number }] | []): number {
  if (val.length === 0) return 0;
  const row = val[0];
  if (!row) return 0;
  return row.count;
}

// ---------------------------------------------------------------------------
// Stat card
// ---------------------------------------------------------------------------

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div
      style={{
        padding: '1rem 1.5rem',
        background: '#1a1a1a',
        border: '1px solid #2a2a2a',
        borderRadius: 6,
        minWidth: 160,
      }}
    >
      <div style={{ fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5 }}>
        {label}
      </div>
      <div style={{ fontSize: 28, fontWeight: 700, color: '#86c7a3', marginTop: '0.3rem' }}>
        {value}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function JobsPage() {
  const { currentOrg } = useOrg();
  const { jobs, loading, error, refresh } = useJobs();
  const navigate = useNavigate();
  const [showCreate, setShowCreate] = useState(false);

  if (!currentOrg) {
    return (
      <section>
        <h1>Jobs</h1>
        <p style={{ color: '#888' }}>Pick an organisation to see jobs.</p>
      </section>
    );
  }

  const activeCount = jobs.filter((j) => j.status === 'active').length;
  const totalAttachedBills = jobs.reduce((sum, j) => sum + getBillCount(j.attached_bills), 0);

  return (
    <section>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '1rem' }}>
        <h1 style={{ margin: 0 }}>Jobs</h1>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          {!loading && (
            <span style={{ color: '#888', fontSize: 13 }}>
              {jobs.length} job{jobs.length !== 1 ? 's' : ''}
            </span>
          )}
          <button onClick={() => setShowCreate(true)} style={primaryBtn}>+ New job</button>
        </div>
      </div>

      {showCreate && (
        <CreateJobForm
          onClose={() => setShowCreate(false)}
          onCreated={(id) => { setShowCreate(false); void refresh(); navigate(`/jobs/${id}`); }}
        />
      )}

      {/* Stat cards */}
      {!loading && !error && (
        <div style={{ display: 'flex', gap: '1rem', marginBottom: '1.75rem', flexWrap: 'wrap' }}>
          <StatCard label="Active jobs" value={activeCount} />
          <StatCard label="Total bills attached" value={totalAttachedBills} />
        </div>
      )}

      {loading ? (
        <p style={{ color: '#888' }}>Loading jobs…</p>
      ) : error ? (
        <p style={{ color: 'salmon' }}>Failed to load: {error}</p>
      ) : jobs.length === 0 ? (
        <p style={{ color: '#888' }}>No jobs yet for {currentOrg.name}.</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid #2a2a2a' }}>
              <th style={th}>Job #</th>
              <th style={th}>Name</th>
              <th style={th}>Status</th>
              <th style={thRight}>Bills attached</th>
              <th style={thRight}>Bills suggested</th>
              <th style={th}>Created</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => {
              const attached = getBillCount(j.attached_bills);
              const suggested = getBillCount(j.suggested_bills);
              const created = new Date(j.created_at).toLocaleDateString('en-AU', {
                day: '2-digit',
                month: 'short',
                year: 'numeric',
              });
              return (
                <tr
                  key={j.id}
                  style={{ borderBottom: '1px solid #1a1a1a', cursor: 'pointer' }}
                  onClick={() => void navigate(`/jobs/${j.id}`)}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLTableRowElement).style.background = '#202020';
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLTableRowElement).style.background = '';
                  }}
                >
                  <td style={td}>
                    <code style={{ color: '#888', fontSize: 12 }}>{j.job_number}</code>
                  </td>
                  <td style={{ ...td, fontWeight: 500 }}>{j.name}</td>
                  <td style={td}>
                    <span
                      style={{
                        padding: '0.15rem 0.5rem',
                        fontSize: 11,
                        borderRadius: 3,
                        background: '#222',
                        color: statusColors[j.status],
                        textTransform: 'uppercase',
                      }}
                    >
                      {j.status}
                    </span>
                  </td>
                  <td style={tdRight}>
                    {attached > 0 ? (
                      <span style={{ color: '#86c7a3', fontWeight: 600 }}>{attached}</span>
                    ) : (
                      <span style={{ color: '#444' }}>0</span>
                    )}
                  </td>
                  <td style={tdRight}>
                    {suggested > 0 ? (
                      <span style={{ color: '#d2c886' }}>{suggested}</span>
                    ) : (
                      <span style={{ color: '#444' }}>0</span>
                    )}
                  </td>
                  <td style={{ ...td, color: '#666', fontSize: 13 }}>{created}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

interface CustomerOption { id: string; name: string }

function CreateJobForm({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { currentOrg } = useOrg();
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [name, setName] = useState('');
  const [jobNumber, setJobNumber] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [budget, setBudget] = useState(0);
  const [startDate, setStartDate] = useState(new Date().toISOString().slice(0, 10));
  const [endDate, setEndDate] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Load customers + auto-generate next job number
  useEffect(() => {
    if (!currentOrg) return;
    void (async () => {
      const [{ data: custs }, { data: maxRow }] = await Promise.all([
        supabase.from('customers').select('id, name').eq('organization_id', currentOrg.id).is('deleted_at', null).order('name'),
        supabase.from('jobs').select('job_number').eq('organization_id', currentOrg.id).order('job_number', { ascending: false }).limit(1).maybeSingle(),
      ]);
      setCustomers((custs ?? []) as CustomerOption[]);
      // Auto-suggest next JNNNN — find highest existing then +1
      const last = maxRow?.job_number ?? '';
      const m = last.match(/^J(\d+)$/);
      const next = m ? parseInt(m[1], 10) + 1 : 1;
      setJobNumber(`J${String(next).padStart(4, '0')}`);
    })();
  }, [currentOrg]);

  const submit = async () => {
    if (!currentOrg || !name.trim() || !jobNumber.trim()) return;
    setBusy(true);
    const { data, error } = await supabase
      .from('jobs')
      .insert({
        organization_id: currentOrg.id,
        job_number: jobNumber.trim(),
        name: name.trim(),
        description: description.trim() || null,
        customer_id: customerId || null,
        status: 'active' as JobStatus,
        budget_cents: budget > 0 ? Math.round(budget * 100) : null,
        start_date: startDate || null,
        end_date: endDate || null,
        currency_code: 'AUD',
      })
      .select('id')
      .single();
    setBusy(false);
    if (error) { setErr(error.message); return; }
    onCreated(data.id);
  };

  return (
    <div style={card}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h3 style={{ fontSize: 14, margin: 0 }}>New job</h3>
        <button onClick={onClose} style={closeBtn}>×</button>
      </div>
      <div style={grid2}>
        <Field label="Job number *">
          <input value={jobNumber} onChange={(e) => setJobNumber(e.target.value)} style={inp} />
        </Field>
        <Field label="Name / address *">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. 1 Schablon Close, Ormeau Hills" style={inp} />
        </Field>
      </div>
      <Field label="Customer">
        <select value={customerId} onChange={(e) => setCustomerId(e.target.value)} style={inp}>
          <option value="">— no customer (link later) —</option>
          {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </Field>
      <Field label="Description">
        <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} style={inp} />
      </Field>
      <div style={grid3}>
        <Field label="Budget (AUD)"><input type="number" step="0.01" value={budget} onChange={(e) => setBudget(parseFloat(e.target.value) || 0)} style={inp} /></Field>
        <Field label="Start date"><input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} style={inp} /></Field>
        <Field label="End date (est.)"><input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} style={inp} /></Field>
      </div>
      <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
        <button onClick={submit} disabled={busy || !name.trim() || !jobNumber.trim()} style={primaryBtn}>{busy ? 'Creating…' : 'Create job'}</button>
        <button onClick={onClose} disabled={busy} style={ghostBtn}>Cancel</button>
      </div>
      {err && <p style={{ color: 'salmon', fontSize: 12, marginTop: 8 }}>{err}</p>}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label style={{ display: 'block', fontSize: 11, color: '#888', marginTop: 8 }}><div style={{ marginBottom: 3 }}>{label}</div>{children}</label>;
}

const card: React.CSSProperties = { marginBottom: 16, padding: 16, background: '#0e0e0e', border: '1px solid #2a2a2a', borderRadius: 6, maxWidth: 720 };
const grid2: React.CSSProperties = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 };
const grid3: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 };
const inp: React.CSSProperties = { width: '100%', padding: '6px 8px', background: '#000', color: '#ddd', border: '1px solid #333', borderRadius: 3, fontSize: 12 };
const primaryBtn: React.CSSProperties = { padding: '0.5rem 1rem', background: '#1c4868', color: '#fff', border: '1px solid #5096d8', borderRadius: 4, fontSize: 13, fontWeight: 600, cursor: 'pointer' };
const ghostBtn: React.CSSProperties = { padding: '0.5rem 1rem', background: 'transparent', color: '#aaa', border: '1px solid #333', borderRadius: 4, fontSize: 12, cursor: 'pointer' };
const closeBtn: React.CSSProperties = { background: 'transparent', color: '#888', border: 'none', fontSize: 18, cursor: 'pointer', padding: 0 };

const th: React.CSSProperties = {
  padding: '0.5rem 0.75rem',
  textAlign: 'left',
  fontSize: 12,
  color: '#888',
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  fontWeight: 500,
};
const thRight: React.CSSProperties = { ...th, textAlign: 'right' };
const td: React.CSSProperties = { padding: '0.65rem 0.75rem' };
const tdRight: React.CSSProperties = { ...td, textAlign: 'right' };
