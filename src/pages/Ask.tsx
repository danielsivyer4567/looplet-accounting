import { useState, useRef, useEffect } from 'react';
import { supabase } from '@/lib/supabase';
import { useOrg } from '@/hooks/useOrg';
import { useLocation, useNavigate } from 'react-router-dom';
import { TopDownMindMap, type MindMapBranch } from '@/components/InsightCharts';
import { DiagramView, type DiagramSpec } from '@/components/DiagramView';
import { CitedAnswer, type LegalCitation } from '@/components/Citations';
import { Sparkles, ArrowRight, Terminal, HelpCircle, Code, GitBranch, Eraser } from 'lucide-react';

interface AskResponse {
  ok: boolean;
  route?: 'data' | 'knowledge' | 'hybrid';
  answer?: string;
  sql?: string | null;
  sql_error?: string | null;
  data_rows?: Record<string, unknown>[];
  data_row_count?: number;
  citations?: LegalCitation[];
  sonar_citations?: string[];
  business_context?: string;
  visual?: DiagramSpec;
  error?: string;
}

interface ChatTurn {
  question: string;
  response: AskResponse;
  ts: number;
}

const SUGGESTED_QUESTIONS = [
  'Can I claim my new ute under instant asset write-off?',
  'Are tools under $300 immediately deductible or do I depreciate?',
  'Do I need to charge GST on a $50 deposit before work starts?',
  'What tax deadlines are coming up and what should I do now?',
  'When does my next BAS need to be lodged?',
  'Is FBT payable on a ute used 80% for work, 20% personal?',
  'What records do I need to keep for ATO substantiation on fuel?',
  'Show me my P&L YTD',
  'Top 5 suppliers by spend YTD',
];

const TRANSPARENT_ANSWER_RULE =
  'Always return a written answer that can be mirrored as a top-down mind map: question, books/data checked, law/evidence checked, and final decision.';

export function AskPage() {
  const { currentOrg } = useOrg();
  const location = useLocation();
  const navigate = useNavigate();
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<ChatTurn[]>([]);
  const [showSql, setShowSql] = useState<Set<number>>(new Set());
  const [showCtx, setShowCtx] = useState<Set<number>>(new Set());
  const [showMap, setShowMap] = useState<Set<number>>(new Set());
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [history]);

  const ask = async (q: string) => {
    if (!q.trim() || busy || !currentOrg) return;
    setBusy(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not signed in');
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ask-bot`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({
          organization_id: currentOrg.id,
          question: q,
          response_rule: TRANSPARENT_ANSWER_RULE,
        }),
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
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  };

  // A timeline obligation tapped in the right rail routes here with a prompt to run.
  useEffect(() => {
    const incoming = (location.state as { askPrompt?: string } | null)?.askPrompt;
    if (incoming && currentOrg) {
      void ask(incoming);
      navigate(location.pathname, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key]);

  if (!currentOrg) {
    return (
      <section className="animated-fade-in" style={{ padding: '2rem 1.5rem', textAlign: 'center', maxWidth: '600px', margin: '4rem auto' }}>
        <p style={{ color: 'var(--text-muted)' }}>Pick an organisation in the sidebar to ask questions.</p>
      </section>
    );
  }

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

  const toggleCtx = (idx: number) => {
    setShowCtx((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const toggleMap = (idx: number) => {
    setShowMap((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  // Wipe the conversation and return to the suggested-questions view.
  const clearChat = () => {
    setHistory([]);
    setShowSql(new Set());
    setShowCtx(new Set());
    setShowMap(new Set());
    setQuestion('');
    setTimeout(() => inputRef.current?.focus(), 50);
  };

  return (
    <section className="animated-fade-in" style={{ display: 'flex', flexDirection: 'column', minHeight: 'calc(100vh - 120px)', position: 'relative' }}>
      <style>{`
        .suggestion-card {
          padding: 0.75rem 1rem;
          background: var(--bg-card);
          border: 1px solid var(--border-subtle);
          color: var(--text-body);
          border-radius: var(--radius-md);
          font-size: 0.825rem;
          cursor: pointer;
          transition: var(--transition-smooth);
          text-align: left;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 0.5rem;
        }
        .suggestion-card:hover {
          border-color: var(--accent-primary);
          background: var(--bg-hover);
          transform: translateY(-1px);
        }
      `}</style>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', paddingBottom: '100px' }}>
        {/* Header */}
        <div style={{ marginBottom: '1.5rem' }}>
          <h1 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem' }}>
            <Sparkles size={24} style={{ color: 'var(--accent-primary)' }} />
            Ask AI
          </h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem', margin: 0 }}>
            Ask anything about your books or Australian tax regulations. Powered by live accounting records + citation search.
          </p>
        </div>

        {/* Suggestion Grid */}
        {history.length === 0 && (
          <div style={{ marginTop: '2rem', animation: 'fadeIn 0.4s ease' }}>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.075em', marginBottom: '1rem' }}>
              Suggested Inquiries
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '0.75rem' }}>
              {SUGGESTED_QUESTIONS.map((sq) => (
                <button
                  key={sq}
                  onClick={() => void ask(sq)}
                  disabled={busy}
                  className="suggestion-card"
                >
                  <span>{sq}</span>
                  <ArrowRight size={14} style={{ opacity: 0.6, flexShrink: 0 }} />
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Conversation Area */}
        <div style={{ marginTop: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          {history.map((turn, idx) => {
            const r = turn.response;
            const sqlOpen = showSql.has(idx);
            const ctxOpen = showCtx.has(idx);
            const mapOpen = showMap.has(idx);
            const mindMapBranches = buildMindMap(turn);
            const hasVisual = r.ok && r.visual != null && !r.visual.none && (r.visual.nodes?.length ?? 0) >= 2;
            return (
              <div key={turn.ts} style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                
                {/* User Bubble */}
                <div 
                  style={{
                    alignSelf: 'flex-end',
                    maxWidth: '80%',
                    padding: '0.75rem 1.25rem',
                    background: 'linear-gradient(135deg, var(--accent-primary) 0%, #4f46e5 100%)',
                    color: '#fff',
                    borderRadius: 'var(--radius-md) var(--radius-md) 0 var(--radius-md)',
                    fontSize: '0.9rem',
                    lineHeight: '1.45',
                    boxShadow: 'var(--shadow-sm)',
                    animation: 'fadeIn 0.25s ease'
                  }}
                >
                  {turn.question}
                </div>

                {/* Assistant Card */}
                <div 
                  className="card"
                  style={{
                    alignSelf: 'flex-start',
                    width: '100%',
                    maxWidth: '100%',
                    padding: '1.5rem',
                    fontSize: '0.9rem',
                    lineHeight: '1.6',
                    animation: 'fadeIn 0.3s ease',
                    boxShadow: 'var(--shadow-sm)'
                  }}
                >
                  {!r.ok && (
                    <div className="badge badge-danger" style={{ display: 'flex', padding: '0.75rem', justifyContent: 'center' }}>
                      Error: {r.error ?? 'Unknown error occurred'}
                    </div>
                  )}

                  {r.ok && (
                    <>
                      {/* Meta badges */}
                      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
                        <span className="badge badge-neutral" style={{ textTransform: 'capitalize' }}>
                          route: {r.route}
                        </span>
                        {r.data_row_count != null && r.data_row_count > 0 && (
                          <span className="badge badge-success">
                            {r.data_row_count} database rows
                          </span>
                        )}
                        {r.citations && r.citations.length > 0 && (
                          <span className="badge badge-success">
                            {r.citations.length} cited section{r.citations.length === 1 ? '' : 's'}
                          </span>
                        )}
                        {r.sonar_citations && r.sonar_citations.length > 0 && (
                          <span className="badge badge-info">
                            {r.sonar_citations.length} tax sources
                          </span>
                        )}
                      </div>

                      {/* Styled answer — inline [n] markers resolve to the cited legal
                          corpus (NotebookLM click-to-line panel) or, when no corpus was
                          retrieved, to the Sonar source URLs (pre-corpus behaviour). */}
                      <CitedAnswer
                        answer={r.answer ?? ''}
                        citations={r.citations ?? []}
                        sonarCitations={r.sonar_citations ?? []}
                      />

                      {/* Progressive explainer — an ordered, node-by-node walkthrough the bot
                          authors only when the answer has a shape worth walking through. It
                          blends into the card: just text + faint connectors, revealed step by step. */}
                      {hasVisual && r.visual && (
                        <div style={{ marginTop: '1.25rem' }}>
                          <DiagramView spec={r.visual} />
                        </div>
                      )}

                      {/* Reasoning map — the "show my work" transparency view, collapsed by default. */}
                      <div style={{ marginTop: '0.85rem' }}>
                        <button
                          onClick={() => toggleMap(idx)}
                          className="btn btn-secondary"
                          style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.25rem' }}
                          title="How this answer was assembled: question → books → rules → decision"
                        >
                          <GitBranch size={12} />
                          {mapOpen ? 'Hide reasoning map' : 'Show reasoning map'}
                        </button>
                        {mapOpen && <TopDownMindMap root="Transparent answer path" branches={mindMapBranches} />}
                      </div>

                      {/* SQL Database Output Table */}
                      {r.data_rows && r.data_rows.length > 0 && (
                        <div style={{ marginTop: '1.25rem' }} className="table-premium-container">
                          <DataTable rows={r.data_rows} />
                        </div>
                      )}

                      {/* Sonar citations block */}
                      {r.sonar_citations && r.sonar_citations.length > 0 && (
                        <div style={{ marginTop: '1.5rem', padding: '1rem', background: 'var(--bg-app)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)' }}>
                          <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--accent-info)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '0.5rem' }}>
                            Sources & Citations
                          </div>
                          {r.sonar_citations.map((url, i) => (
                            <div key={i} style={{ display: 'flex', gap: '0.5rem', fontSize: '0.8rem', marginBottom: '0.35rem', alignItems: 'baseline' }}>
                              <span style={{ color: 'var(--accent-info)', fontWeight: 'bold' }}>[{i + 1}]</span>
                              <a href={url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent-primary)', wordBreak: 'break-all' }}>
                                {url}
                              </a>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Transparency and Debugging logs */}
                      {(r.sql || r.sql_error || r.business_context) && (
                        <div style={{ marginTop: '1.25rem', paddingTop: '1rem', borderTop: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                            {(r.sql || r.sql_error) && (
                              <button
                                onClick={() => toggleSql(idx)}
                                className="btn btn-secondary"
                                style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.25rem' }}
                              >
                                <Code size={12} />
                                {sqlOpen ? 'Hide SQL Query' : 'View SQL Query'}
                              </button>
                            )}
                            {r.business_context && (
                              <button
                                onClick={() => toggleCtx(idx)}
                                className="btn btn-secondary"
                                style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.25rem' }}
                                title="What the agent knew about your business"
                              >
                                <Terminal size={12} />
                                {ctxOpen ? 'Hide Context Profile' : 'Show Context Profile'}
                              </button>
                            )}
                          </div>
                          
                          {sqlOpen && r.sql && (
                            <pre style={{ margin: 0, padding: '0.75rem', background: 'var(--bg-app)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', fontSize: '0.775rem', overflowX: 'auto', color: 'var(--text-title)', whiteSpace: 'pre-wrap' }}>
                              <code>{r.sql}</code>
                            </pre>
                          )}
                          
                          {sqlOpen && r.sql_error && (
                            <div className="badge badge-danger" style={{ display: 'block', padding: '0.5rem', textAlign: 'left', fontSize: '0.75rem', textTransform: 'none' }}>
                              SQL compilation error: {r.sql_error}
                            </div>
                          )}
                          
                          {ctxOpen && r.business_context && (
                            <pre style={{ margin: 0, padding: '0.75rem', background: 'var(--bg-app)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', fontSize: '0.775rem', overflowX: 'auto', color: 'var(--text-muted)', whiteSpace: 'pre-wrap', lineHeight: '1.4' }}>
                              {r.business_context}
                            </pre>
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
      </div>

      {/* Floating Bottom Input Bar */}
      <div 
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          background: 'var(--bg-app)',
          padding: '1rem 0 1.5rem 0',
          borderTop: '1px solid var(--border-subtle)',
          boxSizing: 'border-box'
        }}
      >
        {history.length > 0 && (
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '0.5rem' }}>
            <button
              onClick={clearChat}
              disabled={busy}
              className="btn btn-secondary"
              title="Clear the conversation and start over"
              style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', padding: '0.4rem 0.8rem', fontSize: '0.78rem' }}
            >
              <Eraser size={14} />
              Clear chat
            </button>
          </div>
        )}
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'stretch' }}>
          <textarea
            ref={inputRef}
            className="form-input"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={busy ? 'Processing request…' : 'Ask anything about your books or Australian tax regulations…'}
            disabled={busy}
            rows={2}
            style={{
              resize: 'none',
              borderRadius: 'var(--radius-md)',
              lineHeight: '1.4',
              padding: '0.75rem 1rem'
            }}
          />
          <button
            onClick={() => void ask(question)}
            disabled={busy || !question.trim()}
            className="btn btn-primary"
            style={{
              padding: '0 1.5rem',
              borderRadius: 'var(--radius-md)',
              fontWeight: 600,
              fontSize: '0.875rem'
            }}
          >
            {busy ? '…' : 'Send'}
          </button>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.675rem', color: 'var(--text-muted)', marginTop: '0.35rem', padding: '0 0.25rem' }}>
          <span>Enter to send · Shift+Enter for newline</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: '0.15rem' }}>
            <HelpCircle size={10} /> Cost: ~$0.0004 per inquiry
          </span>
        </div>
      </div>
    </section>
  );
}

function compactText(text: string, max = 120): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, max - 1).trim()}…`;
}

function firstSentence(text: string): string {
  const cleaned = text.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
  const match = cleaned.match(/^(.+?[.!?])(\s|$)/);
  return compactText(match?.[1] ?? cleaned, 140);
}

function buildMindMap(turn: ChatTurn): MindMapBranch[] {
  const r = turn.response;
  if (!r.ok) {
    return [
      { title: 'Question', detail: compactText(turn.question), tone: 'primary' },
      { title: 'Path', detail: 'The request failed before evidence could be assembled.', tone: 'danger' },
      { title: 'Action', detail: r.error ?? 'Retry after checking the connection and server logs.', tone: 'warning' },
    ];
  }

  const needsData = r.route === 'data' || r.route === 'hybrid';
  const needsKnowledge = r.route === 'knowledge' || r.route === 'hybrid';
  return [
    { title: 'Question', detail: compactText(turn.question), tone: 'primary' },
    {
      title: 'Books checked',
      detail: needsData
        ? r.sql_error
          ? `Data query failed: ${compactText(r.sql_error, 90)}`
          : `${r.data_row_count ?? 0} ledger row${(r.data_row_count ?? 0) === 1 ? '' : 's'} returned.`
        : 'No ledger query needed for this answer.',
      tone: r.sql_error ? 'danger' : needsData ? 'success' : 'neutral',
    },
    {
      title: 'Rules checked',
      detail: needsKnowledge
        ? `${r.sonar_citations?.length ?? 0} cited tax source${(r.sonar_citations?.length ?? 0) === 1 ? '' : 's'} attached.`
        : 'Answered from company records rather than external tax research.',
      tone: needsKnowledge && (r.sonar_citations?.length ?? 0) === 0 ? 'warning' : 'info',
    },
    { title: 'Decision', detail: firstSentence(r.answer ?? 'No written answer returned.'), tone: 'success' },
  ];
}

function DataTable({ rows }: { rows: Record<string, unknown>[] }) {
  const firstRow = rows[0];
  if (!firstRow) return null;
  const cols = Object.keys(firstRow);
  return (
    <table className="table-premium">
      <thead>
        <tr>
          {cols.map((c) => (
            <th key={c} style={{ fontSize: '0.7rem' }}>{c}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.slice(0, 20).map((r, idx) => (
          <tr key={idx}>
            {cols.map((c) => (
              <td key={c} style={{ fontSize: '0.8rem', whiteSpace: 'nowrap' }}>
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

