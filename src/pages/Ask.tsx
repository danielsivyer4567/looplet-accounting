import { useState, useRef, useEffect } from 'react';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/contexts/OrgContext';

interface AskResponse {
  ok: boolean;
  route?: 'data' | 'knowledge' | 'hybrid';
  answer?: string;
  sql?: string | null;
  sql_error?: string | null;
  data_rows?: Record<string, unknown>[];
  data_row_count?: number;
  sonar_citations?: string[];
  error?: string;
}

interface ChatTurn {
  question: string;
  response: AskResponse;
  ts: number;
}

const SUGGESTED_QUESTIONS = [
  'What was my BAS GST last quarter?',
  'Show me my P&L year-to-date',
  'Top 5 suppliers by spend YTD',
  'Unpaid bills overdue more than 14 days',
  'Is my Bunnings spend within ATO substantiation rules?',
  'What\'s the deadline for Q3 BAS lodgement?',
  'Are tools and equipment under $300 deductible?',
  'How much GST do I owe right now?',
];

export function AskPage() {
  const { currentOrg } = useOrg();
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<ChatTurn[]>([]);
  const [showSql, setShowSql] = useState<Set<number>>(new Set());
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [history]);

  if (!currentOrg) return <p style={{ color: '#888' }}>Pick an organisation first.</p>;

  const ask = async (q: string) => {
    if (!q.trim() || busy) return;
    setBusy(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not signed in');
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ask-bot`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ organization_id: currentOrg.id, question: q }),
      });
      const body = (await res.json()) as AskResponse;
      setHistory((h) => [...h, { question: q, response: body, ts: Date.now() }]);
      setQuestion('');
    } catch (e) {
      setHistory((h) => [...h, {
        question: q,
        response: { ok: false, error: e instanceof Error ? e.message : String(e) },
        ts: Date.now(),
      }]);
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void ask(question);
    }
  };

  const toggleSql = (idx: number) => {
    setShowSql((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  return (
    <section style={{ display: 'flex', gap: 24, alignItems: 'flex-start' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <h1 style={{ margin: 0, marginBottom: 4 }}>Ask</h1>
        <p style={{ color: '#888', fontSize: 13, marginTop: 0 }}>
          Ask anything about your books or AU-tax rules. Backed by your live data + Perplexity Sonar for citations.
        </p>

        {history.length === 0 && (
          <div style={{ marginTop: 24 }}>
            <div style={{ fontSize: 11, color: '#666', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>
              Try one of these
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {SUGGESTED_QUESTIONS.map((sq) => (
                <button
                  key={sq}
                  onClick={() => void ask(sq)}
                  disabled={busy}
                  style={{
                    padding: '0.4rem 0.7rem',
                    background: '#0e1820',
                    color: '#9ab0c0',
                    border: '1px solid #1f3a52',
                    borderRadius: 4,
                    fontSize: 12,
                    cursor: 'pointer',
                    textAlign: 'left',
                  }}
                >
                  {sq}
                </button>
              ))}
            </div>
          </div>
        )}

        <div style={{ marginTop: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
          {history.map((turn, idx) => {
            const r = turn.response;
            const sqlOpen = showSql.has(idx);
            return (
              <div key={turn.ts} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {/* Question bubble */}
                <div style={{
                  alignSelf: 'flex-end',
                  maxWidth: '80%',
                  padding: '0.6rem 0.9rem',
                  background: '#1c4868',
                  color: '#fff',
                  borderRadius: 8,
                  fontSize: 13,
                  lineHeight: 1.4,
                }}>
                  {turn.question}
                </div>

                {/* Answer card */}
                <div style={{
                  alignSelf: 'flex-start',
                  maxWidth: '92%',
                  padding: '0.9rem 1rem',
                  background: '#1a1a1a',
                  border: '1px solid #2a2a2a',
                  borderRadius: 8,
                  fontSize: 13,
                  lineHeight: 1.5,
                  color: '#e3e3e3',
                  width: '100%',
                }}>
                  {!r.ok && (
                    <div style={{ color: 'salmon', fontSize: 12 }}>Error: {r.error ?? 'unknown'}</div>
                  )}

                  {r.ok && (
                    <>
                      <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
                        <Pill text={`route: ${r.route}`} colour="#9ab0c0" bg="#0e1820" />
                        {r.data_row_count != null && r.data_row_count > 0 && (
                          <Pill text={`${r.data_row_count} rows`} colour="#86c7a3" bg="#0d2f1f" />
                        )}
                        {r.sonar_citations && r.sonar_citations.length > 0 && (
                          <Pill text={`✦ ${r.sonar_citations.length} sources`} colour="#7fb6e8" bg="#0e1820" />
                        )}
                      </div>

                      <div style={{ whiteSpace: 'pre-wrap' }}>{r.answer}</div>

                      {/* Data table preview */}
                      {r.data_rows && r.data_rows.length > 0 && (
                        <div style={{ marginTop: 12, overflowX: 'auto' }}>
                          <DataTable rows={r.data_rows} />
                        </div>
                      )}

                      {/* Sonar citations */}
                      {r.sonar_citations && r.sonar_citations.length > 0 && (
                        <div style={{ marginTop: 12, fontSize: 11, color: '#666' }}>
                          <div style={{ marginBottom: 4, color: '#7fb6e8' }}>✦ Sources</div>
                          {r.sonar_citations.map((url, i) => (
                            <div key={i} style={{ marginBottom: 2 }}>
                              <span style={{ color: '#7fb6e8', marginRight: 4 }}>[{i + 1}]</span>
                              <a href={url} target="_blank" rel="noopener noreferrer" style={{ color: '#5096d8', textDecoration: 'none', wordBreak: 'break-all' }}>
                                {url}
                              </a>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* SQL transparency */}
                      {(r.sql || r.sql_error) && (
                        <div style={{ marginTop: 12, fontSize: 11 }}>
                          <button
                            onClick={() => toggleSql(idx)}
                            style={{
                              background: 'transparent',
                              color: '#666',
                              border: '1px solid #2a2a2a',
                              borderRadius: 3,
                              padding: '0.15rem 0.5rem',
                              fontSize: 10,
                              cursor: 'pointer',
                            }}
                          >
                            {sqlOpen ? '− hide SQL' : '+ show SQL'}
                          </button>
                          {sqlOpen && r.sql && (
                            <pre style={{
                              marginTop: 6,
                              padding: 8,
                              background: '#0a0a0a',
                              border: '1px solid #2a2a2a',
                              borderRadius: 3,
                              fontSize: 11,
                              color: '#aaa',
                              whiteSpace: 'pre-wrap',
                              wordBreak: 'break-word',
                            }}>{r.sql}</pre>
                          )}
                          {sqlOpen && r.sql_error && (
                            <div style={{ marginTop: 6, color: 'salmon', fontSize: 11 }}>
                              SQL error: {r.sql_error}
                            </div>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <div style={{
          position: 'sticky',
          bottom: 0,
          marginTop: 16,
          padding: '12px 0',
          background: '#0a0a0a',
          borderTop: '1px solid #2a2a2a',
        }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <textarea
              ref={inputRef}
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={busy ? 'Thinking…' : 'Ask anything about your books or AU tax rules…'}
              disabled={busy}
              rows={2}
              style={{
                flex: 1,
                padding: '0.6rem 0.8rem',
                background: '#1a1a1a',
                color: '#fff',
                border: '1px solid #2a2a2a',
                borderRadius: 4,
                fontSize: 13,
                fontFamily: 'inherit',
                resize: 'none',
              }}
            />
            <button
              onClick={() => void ask(question)}
              disabled={busy || !question.trim()}
              style={{
                padding: '0 1.2rem',
                background: '#1c4868',
                color: '#fff',
                border: '1px solid #5096d8',
                borderRadius: 4,
                fontSize: 13,
                fontWeight: 600,
                cursor: busy ? 'wait' : 'pointer',
                opacity: !question.trim() ? 0.5 : 1,
              }}
            >
              {busy ? '…' : 'Ask'}
            </button>
          </div>
          <div style={{ fontSize: 10, color: '#666', marginTop: 4 }}>
            Enter to send · Shift+Enter for newline · Cost ~$0.0004 per question
          </div>
        </div>
      </div>
    </section>
  );
}

function DataTable({ rows }: { rows: Record<string, unknown>[] }) {
  if (rows.length === 0) return null;
  const cols = Object.keys(rows[0]!);
  return (
    <table style={{ borderCollapse: 'collapse', fontSize: 12, width: '100%' }}>
      <thead>
        <tr style={{ borderBottom: '1px solid #2a2a2a' }}>
          {cols.map((c) => (
            <th key={c} style={{
              padding: '0.3rem 0.5rem', textAlign: 'left', fontSize: 10,
              color: '#888', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 500,
              whiteSpace: 'nowrap',
            }}>{c}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.slice(0, 20).map((r, idx) => (
          <tr key={idx} style={{ borderBottom: '1px solid #1a1a1a' }}>
            {cols.map((c) => (
              <td key={c} style={{ padding: '0.3rem 0.5rem', fontSize: 11, color: '#ccc', whiteSpace: 'nowrap' }}>
                {formatCell(r[c], c)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function formatCell(v: unknown, col: string): string {
  if (v == null) return '—';
  if (typeof v === 'number' && col.endsWith('_cents')) {
    return `$${(v / 100).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  if (typeof v === 'string' && v.length > 50) return v.slice(0, 47) + '…';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function Pill({ text, colour, bg }: { text: string; colour: string; bg: string }) {
  return (
    <span style={{
      padding: '0.15rem 0.5rem',
      fontSize: 10,
      borderRadius: 3,
      background: bg,
      color: colour,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      fontWeight: 500,
    }}>{text}</span>
  );
}
