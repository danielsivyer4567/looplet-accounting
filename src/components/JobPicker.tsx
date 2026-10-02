import { useState, useRef, useEffect } from 'react';
import { useJobSearch, type JobOption } from '@/hooks/useJobSearch';

interface JobPickerProps {
  onPick: (job: JobOption) => void;
  placeholder?: string;
  busy?: boolean;
}

export function JobPicker({
  onPick,
  placeholder = 'Search jobs by number or name…',
  busy,
}: JobPickerProps) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const { results, loading } = useJobSearch(query);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClickOutside = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  return (
    <div ref={wrapRef} style={{ position: 'relative', width: '100%' }}>
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => setOpen(true)}
        placeholder={placeholder}
        disabled={busy}
        style={{
          width: '100%',
          padding: '0.5rem 0.75rem',
          background: 'var(--bg-card)',
          color: 'var(--text-title)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 4,
          fontSize: 14,
        }}
      />
      {open && (results.length > 0 || loading) && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            background: 'var(--bg-card)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 4,
            marginTop: 4,
            zIndex: 10,
            maxHeight: 280,
            overflowY: 'auto',
            boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
          }}
        >
          {loading && (
            <div style={{ padding: '0.5rem 0.75rem', color: 'var(--text-muted)', fontSize: 13 }}>Searching…</div>
          )}
          {results.map((job) => (
            <button
              key={job.id}
              type="button"
              onClick={() => {
                onPick(job);
                setOpen(false);
                setQuery('');
              }}
              disabled={busy}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '0.5rem 0.75rem',
                background: 'transparent',
                border: 'none',
                borderBottom: '1px solid var(--border-subtle)',
                color: 'var(--text-title)',
                cursor: busy ? 'wait' : 'pointer',
                fontSize: 13,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = '#2a2a2a';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent';
              }}
            >
              <div style={{ fontWeight: 600 }}>
                <code style={{ color: 'var(--text-success)' }}>{job.job_number}</code>{' '}
                <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>{job.name}</span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{job.status}</div>
            </button>
          ))}
          {!loading && results.length === 0 && query.length > 0 && (
            <div style={{ padding: '0.5rem 0.75rem', color: 'var(--text-muted)', fontSize: 13 }}>
              No active jobs match "{query}"
            </div>
          )}
        </div>
      )}
    </div>
  );
}
