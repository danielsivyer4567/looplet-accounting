import { Fragment, useState, type CSSProperties } from 'react';
import { CalendarClock, ChevronDown, ChevronsRight, Sparkles } from 'lucide-react';
import {
  isCompletedObligationStatus,
  type ObligationIntent,
  type ObligationStage,
  type TaxObligation,
} from '@/hooks/useTaxCalendar';

const stageColor: Record<ObligationStage, string> = {
  overdue: 'var(--accent-danger)',
  due_soon: 'var(--accent-warning)',
  upcoming: 'var(--accent-info)',
  done: 'var(--accent-success)',
};

function fmtShort(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
}

function countdown(stage: ObligationStage, days: number): string {
  if (stage === 'done') return 'done';
  if (stage === 'overdue') return `${Math.abs(days)}d overdue`;
  if (days === 0) return 'due today';
  return `in ${days}d`;
}

function displayStage(o: TaxObligation): ObligationStage {
  return isCompletedObligationStatus(o.status) ? 'done' : o.stage;
}

function ym(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

interface MonthCell {
  key: string;
  monthLabel: string;
  year: number;
  isYearStart: boolean;
  isCurrent: boolean;
  items: TaxObligation[];
}

/** Continuous month axis from the earliest to latest obligation, every month in between. */
function buildAxis(obligations: TaxObligation[]): MonthCell[] {
  if (obligations.length === 0) return [];
  const times = obligations
    .map((o) => new Date(`${o.due_date}T00:00:00`).getTime())
    .sort((a, b) => a - b);
  const first = new Date(times[0] ?? Date.now());
  const last = new Date(times[times.length - 1] ?? Date.now());
  const cursor = new Date(first.getFullYear(), first.getMonth(), 1);
  const end = new Date(last.getFullYear(), last.getMonth(), 1);
  const nowKey = ym(new Date());

  const cells: MonthCell[] = [];
  let prevYear: number | null = null;
  while (cursor <= end) {
    const key = ym(cursor);
    cells.push({
      key,
      monthLabel: cursor.toLocaleDateString('en-AU', { month: 'short' }).toUpperCase(),
      year: cursor.getFullYear(),
      isYearStart: prevYear === null || cursor.getFullYear() !== prevYear,
      isCurrent: key === nowKey,
      items: obligations.filter((o) => o.due_date.slice(0, 7) === key),
    });
    prevYear = cursor.getFullYear();
    cursor.setMonth(cursor.getMonth() + 1);
  }
  return cells;
}

/**
 * Vertical calendar timeline hugging the right edge — a continuous month/year axis
 * with horizontal lines reaching toward the centre. Each obligation is clickable:
 * it expands an inline dropdown and can hand off to the Ask AI chat (via onAsk) for
 * a plain-English, step-by-step explanation.
 */
export function TaxTimeline({
  obligations,
  loading,
  error,
  onAsk,
  onHide,
}: {
  obligations: TaxObligation[];
  loading: boolean;
  error: string | null;
  onAsk?: (obligation: TaxObligation, intent: ObligationIntent) => void;
  onHide?: () => void;
}) {
  const cells = buildAxis(obligations);
  const overdueCount = obligations.filter((o) => displayStage(o) === 'overdue').length;
  const [openKey, setOpenKey] = useState<string | null>(null);

  return (
    <div className="tt">
      <style>{`
        .tt { font-family: var(--font-sans); font-size: 0.72rem; }
        .tt-head { display: flex; align-items: center; gap: 0.4rem; margin-bottom: 0.15rem; }
        .tt-head h2 { margin: 0; font-size: 0.95rem; font-family: var(--font-title); }
        .tt-hide {
          margin-left: auto; background: transparent; border: none; color: var(--text-muted);
          cursor: pointer; padding: 0.2rem; border-radius: 6px; display: flex; transition: var(--transition-smooth);
        }
        .tt-hide:hover { background: var(--bg-hover); color: var(--text-title); }
        .tt-sub { color: var(--text-muted); font-size: 0.75rem; margin: 0 0 1.25rem; }
        .tt-empty { color: var(--text-muted); font-size: 0.72rem; line-height: 1.5; }
        .tt-skel { height: 12px; border-radius: 4px; background: var(--border-subtle); margin-bottom: 0.55rem; opacity: 0.6; }

        .tt-axis { position: relative; padding-top: 0.25rem; }
        .tt-axis::before {
          content: ""; position: absolute; top: 0.4rem; bottom: 0.4rem; right: 17px;
          width: 2px; background: var(--border-subtle); border-radius: 2px;
        }

        .tt-year { position: relative; height: 2.7rem; }
        .tt-year .yc {
          position: absolute; right: 1px; top: 0.35rem; width: 34px; height: 34px; border-radius: 50%;
          background: var(--bg-card); border: 1px solid var(--border-subtle); color: var(--text-title);
          display: flex; align-items: center; justify-content: center;
          font-size: 0.75rem; font-weight: 800; z-index: 2; box-shadow: var(--shadow-sm);
        }

        .tt-row { position: relative; min-height: 2rem; padding: 0 3.2rem 0.6rem 0; }
        .tt-row .hline {
          position: absolute; right: 18px; left: 0.1rem; top: 0.5rem; height: 1px;
          background: var(--border-subtle); opacity: 0.4;
        }
        .tt-row .mdot {
          position: absolute; right: 13px; top: 0.3rem; width: 10px; height: 10px; border-radius: 50%;
          background: var(--bg-app); border: 2px solid var(--text-muted); z-index: 1;
        }
        .tt-row .mlabel {
          position: absolute; right: 30px; top: 0.26rem; font-size: 0.75rem; font-weight: 800;
          letter-spacing: 0.05em; color: var(--text-muted); background: var(--bg-app); padding-left: 4px;
        }
        .tt-row.is-now .mdot {
          border-color: var(--accent-primary); background: var(--accent-primary);
          box-shadow: 0 0 0 3px var(--bg-app), 0 0 10px var(--accent-primary);
        }
        .tt-row.is-now .mlabel { color: var(--text-link); }

        .tt-events { display: flex; flex-direction: column; gap: 0.2rem; padding-top: 0.05rem; }

        .ev {
          width: 100%; text-align: left; display: flex; gap: 0.5rem; align-items: flex-start;
          background: transparent; border: 1px solid transparent; border-radius: 9px;
          padding: 0.4rem 0.45rem; cursor: pointer; transition: var(--transition-smooth);
          font: inherit; color: inherit;
        }
        .ev:hover { background: var(--bg-hover); }
        .ev.open { background: var(--bg-card); border-color: var(--border-subtle); box-shadow: var(--shadow-sm); }
        .ev-dot {
          flex-shrink: 0; width: 9px; height: 9px; margin-top: 4px; border-radius: 50%;
          background: var(--c); box-shadow: 0 0 8px var(--c);
        }
        .ev-body { flex: 1; min-width: 0; }
        .ev-title { color: var(--text-title); font-weight: 600; line-height: 1.25; font-size: 0.78rem; }
        .ev-meta { display: flex; align-items: center; gap: 0.35rem; margin-top: 0.15rem; flex-wrap: wrap; }
        .ev-date { color: var(--text-muted); font-size: 0.75rem; }
        .ev-badge {
          font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.02em;
          padding: 0.05rem 0.35rem; border-radius: var(--radius-full); white-space: nowrap;
          color: var(--c); background: color-mix(in srgb, var(--c), transparent 86%);
        }
        .ev-caret { color: var(--text-muted); flex-shrink: 0; margin-top: 3px; transition: transform 0.2s ease; }
        .ev.open .ev-caret { transform: rotate(180deg); }

        .ev-panel {
          margin: 0.15rem 0 0.4rem; padding: 0.6rem 0.65rem;
          background: var(--bg-app); border: 1px solid var(--border-subtle); border-radius: 9px;
          animation: ttFade 0.18s ease;
        }
        @keyframes ttFade { from { opacity: 0; transform: translateY(-3px); } to { opacity: 1; transform: none; } }
        .ev-why { margin: 0 0 0.55rem; color: var(--text-body); font-size: 0.7rem; line-height: 1.45; }
        .ev-actions { display: flex; flex-wrap: wrap; gap: 0.3rem; }
        .ev-act {
          display: inline-flex; align-items: center; gap: 0.25rem;
          font-size: 0.75rem; font-weight: 600; padding: 0.3rem 0.55rem; border-radius: var(--radius-full);
          border: 1px solid var(--border-subtle); background: var(--bg-card); color: var(--text-body);
          cursor: pointer; transition: var(--transition-smooth);
        }
        .ev-act:hover { border-color: var(--accent-primary); color: var(--text-title); }
        .ev-act.primary { background: var(--accent-primary); border-color: var(--accent-primary); color: var(--text-on-accent); }
        .ev-act.primary:hover { background: var(--accent-primary-hover); }
      `}</style>

      <div className="tt-head">
        <CalendarClock size={16} style={{ color: 'var(--text-link)' }} />
        <h2>Timeline</h2>
        {onHide && (
          <button
            type="button"
            className="tt-hide"
            onClick={onHide}
            title="Hide timeline"
            aria-label="Hide timeline"
          >
            <ChevronsRight size={16} />
          </button>
        )}
      </div>
      <p className="tt-sub">
        {loading
          ? 'Loading…'
          : obligations.length > 0
            ? overdueCount > 0
              ? `${overdueCount} overdue · ${obligations.length} tracked · tap any item`
              : `${obligations.length} obligations · tap any item`
            : 'Your tax obligations'}
      </p>

      {loading && (
        <div>
          {[70, 50, 80, 45, 65].map((w, i) => (
            <div key={i} className="tt-skel" style={{ width: `${w}%` }} />
          ))}
        </div>
      )}

      {!loading && cells.length === 0 && (
        <p className="tt-empty">
          {error
            ? 'Tax calendar isn’t live yet — your BAS, super, TPAR and other deadlines will appear here once the calendar engine is deployed.'
            : 'No obligations yet. Deadlines appear here as your registrations and activity are set up.'}
        </p>
      )}

      {!loading && cells.length > 0 && (
        <div className="tt-axis">
          {cells.map((c) => (
            <Fragment key={c.key}>
              {c.isYearStart && (
                <div className="tt-year">
                  <span className="yc">{c.year}</span>
                </div>
              )}
              <div className={`tt-row${c.isCurrent ? ' is-now' : ''}`}>
                <span className="hline" />
                <span className="mdot" />
                <span className="mlabel">{c.monthLabel}</span>
                {c.items.length > 0 && (
                  <div className="tt-events">
                    {c.items.map((o) => {
                      const id = `${o.obligation_key}-${o.due_date}`;
                      const open = openKey === id;
                      const state = displayStage(o);
                      return (
                        <div key={id} style={{ '--c': stageColor[state] } as CSSProperties}>
                          <button
                            type="button"
                            className={`ev${open ? ' open' : ''}`}
                            onClick={() => setOpenKey(open ? null : id)}
                            aria-expanded={open}
                          >
                            <span className="ev-dot" />
                            <div className="ev-body">
                              <div className="ev-title">{o.title}</div>
                              <div className="ev-meta">
                                <span className="ev-date">{fmtShort(o.due_date)}</span>
                                <span className="ev-badge">
                                  {countdown(state, o.days_until_due)}
                                </span>
                              </div>
                            </div>
                            <ChevronDown size={14} className="ev-caret" />
                          </button>
                          {open && (
                            <div className="ev-panel">
                              {o.description ? <p className="ev-why">{o.description}</p> : null}
                              <div className="ev-actions">
                                <button
                                  type="button"
                                  className="ev-act primary"
                                  onClick={() => onAsk?.(o, 'explain')}
                                >
                                  <Sparkles size={11} /> Explain simply
                                </button>
                                <button
                                  type="button"
                                  className="ev-act"
                                  onClick={() => onAsk?.(o, 'prepare')}
                                >
                                  How to prepare
                                </button>
                                <button
                                  type="button"
                                  className="ev-act"
                                  onClick={() => onAsk?.(o, 'remind')}
                                >
                                  Reminder plan
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}
