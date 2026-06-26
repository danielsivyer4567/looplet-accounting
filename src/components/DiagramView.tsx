import { useEffect, useId, useState } from 'react';
import { ChevronLeft, ChevronRight, RotateCcw } from 'lucide-react';

/**
 * DiagramView — renders a "progressive explainer" as an n8n-style node graph
 * revealed one step at a time.
 *
 * Two layers, kept separate on purpose (see the porting spec):
 *   1. Authoring (the ask-bot edge fn): emits an ORDERED breakdown — title,
 *      intro, 3-6 nodes (each one idea: num / title / tag / caption), and
 *      optional edges only when the flow actually branches.
 *   2. Rendering (this file): boxed nodes wired by connector "strings", revealed
 *      node by node (auto-play + a gated stepper over the same array). The model
 *      never animates anything; the reveal lives entirely here.
 *
 * Linear chains are laid out in a staggered zig-zag (so consecutive nodes are
 * never dead-centre under each other); branching graphs use a layered top-down
 * grid. Themed with the app's CSS variables; the active node carries the accent.
 */

export interface ExplainerNode {
  id: string;
  num?: string;
  title: string;
  tag?: string;
  caption?: string;
}

export interface ExplainerEdge {
  from: string;
  to: string;
  label?: string;
}

export interface DiagramSpec {
  title?: string;
  intro?: string;
  nodes?: ExplainerNode[];
  edges?: ExplainerEdge[];
  none?: boolean;
}

// --- internal layout model ---------------------------------------------------

interface PNode {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  num: string;
  title: string;
  tag?: string | undefined;
  revealAt: number;
}
interface PEdge {
  d: string;
  mx: number;
  my: number;
  label?: string | undefined;
  revealAt: number;
}
interface Narr {
  title: string;
  text: string;
}
interface Layout {
  w: number;
  h: number;
  nodes: PNode[];
  edges: PEdge[];
  narr: Narr[];
}

const NODE_W = 218;
const NODE_H = 64;
const ROW_GAP = 64; // vertical breathing room between a node's bottom and the next node's top
const COL_GAP = 34;
const ZIG = 124; // horizontal stagger amplitude — wide enough that the two columns fully separate
const PAD = 8;
const STEP_MS = 2200; // dwell per step — a calm, controlled "semi slow-motion" cadence
const NARR_FALLBACK = 'and here it is';

const cap1 = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const clip = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

/** Cubic "string" from a node's bottom-centre to the next node's top-centre. */
function stringPath(sx: number, sy: number, tx: number, ty: number): string {
  const dy = ty - sy;
  return `M ${sx} ${sy} C ${sx} ${sy + dy * 0.5}, ${tx} ${ty - dy * 0.5}, ${tx} ${ty}`;
}

function longestPathDepths(ids: string[], edges: ExplainerEdge[]): Map<string, number> {
  const incoming = new Map<string, string[]>();
  ids.forEach((id) => incoming.set(id, []));
  edges.forEach((e) => {
    const parents = incoming.get(e.to);
    if (parents && incoming.has(e.from)) parents.push(e.from);
  });
  const memo = new Map<string, number>();
  const stack = new Set<string>();
  const depth = (id: string): number => {
    const cached = memo.get(id);
    if (cached != null) return cached;
    if (stack.has(id)) return 0;
    stack.add(id);
    const parents = incoming.get(id) ?? [];
    const d = parents.length ? Math.max(...parents.map((p) => depth(p) + 1)) : 0;
    stack.delete(id);
    memo.set(id, d);
    return d;
  };
  ids.forEach(depth);
  return memo;
}

function layoutExplainer(spec: DiagramSpec): Layout {
  const nodes = (spec.nodes ?? [])
    .filter((n) => n && typeof n.title === 'string' && n.title.trim())
    .slice(0, 6);
  const ids = nodes.map((n) => n.id);
  const idSet = new Set(ids);
  const order = new Map(ids.map((id, i) => [id, i]));

  let edges = (spec.edges ?? []).filter((e) => idSet.has(e.from) && idSet.has(e.to)).slice(0, 24);
  if (edges.length === 0) {
    const chain: ExplainerEdge[] = [];
    for (let i = 1; i < nodes.length; i++) {
      const prev = nodes[i - 1];
      const node = nodes[i];
      if (prev && node) chain.push({ from: prev.id, to: node.id });
    }
    edges = chain;
  }

  const depths = longestPathDepths(ids, edges);
  const maxDepth = Math.max(0, ...ids.map((id) => depths.get(id) ?? 0));
  const layers: ExplainerNode[][] = Array.from({ length: maxDepth + 1 }, () => []);
  nodes.forEach((n) => {
    const layer = layers[depths.get(n.id) ?? 0];
    if (layer) layer.push(n);
  });
  const maxCount = Math.max(1, ...layers.map((l) => l.length));
  const linear = maxCount === 1;

  const pos = new Map<string, PNode>();
  let w: number;
  let h: number;

  const place = (n: ExplainerNode, x: number, y: number) => {
    const node: PNode = {
      id: n.id,
      x,
      y,
      w: NODE_W,
      h: NODE_H,
      num: n.num ?? String((order.get(n.id) ?? 0) + 1).padStart(2, '0'),
      title: n.title,
      tag: n.tag,
      revealAt: order.get(n.id) ?? 0,
    };
    pos.set(n.id, node);
  };

  if (linear) {
    // Staggered zig-zag: alternate left / right so nodes never sit dead-centre.
    w = NODE_W + 2 * ZIG + 2 * PAD;
    const centreX = w / 2 - NODE_W / 2;
    nodes.forEach((n, i) => {
      const x = centreX + (i % 2 === 0 ? -ZIG : ZIG);
      const y = PAD + i * (NODE_H + ROW_GAP);
      place(n, x, y);
    });
    h = PAD * 2 + nodes.length * NODE_H + Math.max(0, nodes.length - 1) * ROW_GAP;
  } else {
    // Branching: layered top-down grid.
    w = maxCount * NODE_W + (maxCount - 1) * COL_GAP + 2 * PAD;
    h = PAD * 2 + (maxDepth + 1) * NODE_H + maxDepth * ROW_GAP;
    layers.forEach((layer, d) => {
      const rowW = layer.length * NODE_W + (layer.length - 1) * COL_GAP;
      const startX = (w - rowW) / 2;
      const y = PAD + d * (NODE_H + ROW_GAP);
      layer.forEach((n, j) => place(n, startX + j * (NODE_W + COL_GAP), y));
    });
  }

  const pedges: PEdge[] = [];
  edges.forEach((e) => {
    const s = pos.get(e.from);
    const t = pos.get(e.to);
    if (!s || !t) return;
    const sx = s.x + s.w / 2;
    const sy = s.y + s.h;
    const tx = t.x + t.w / 2;
    const ty = t.y;
    pedges.push({
      d: stringPath(sx, sy, tx, ty),
      mx: (sx + tx) / 2,
      my: (sy + ty) / 2,
      label: e.label,
      revealAt: Math.max(order.get(e.from) ?? 0, order.get(e.to) ?? 0),
    });
  });

  const narr: Narr[] = nodes.map((n) => ({
    title: n.title,
    text: n.caption ?? n.tag ?? NARR_FALLBACK,
  }));
  return { w, h, nodes: [...pos.values()], edges: pedges, narr };
}

// --- node (boxed, n8n-style) -------------------------------------------------

function Node({ n, shown, active }: { n: PNode; shown: boolean; active: boolean }) {
  return (
    <g transform={`translate(${n.x}, ${n.y})`}>
      <g
        style={{
          opacity: shown ? 1 : 0,
          transform: shown ? 'none' : 'translateY(12px)',
          transition: 'opacity 0.8s ease, transform 0.8s cubic-bezier(0.22, 1, 0.36, 1)',
        }}
      >
        <rect
          x={0}
          y={0}
          width={n.w}
          height={n.h}
          rx={12}
          style={{
            fill: active
              ? 'color-mix(in srgb, var(--accent-primary) 18%, var(--bg-card))'
              : 'color-mix(in srgb, var(--bg-card), var(--text-title) 7%)',
            stroke: active
              ? 'var(--accent-primary)'
              : 'color-mix(in srgb, var(--text-muted) 45%, transparent)',
            strokeWidth: active ? 2 : 1.25,
            transition: 'fill 0.6s ease, stroke 0.6s ease, filter 0.6s ease',
            filter: active
              ? 'drop-shadow(0 0 10px color-mix(in srgb, var(--accent-primary) 45%, transparent))'
              : 'drop-shadow(0 5px 12px rgba(0, 0, 0, 0.3))',
          }}
        />
        <text
          x={16}
          y={23}
          style={{
            fill: 'var(--accent-primary)',
            fontSize: '10px',
            fontWeight: 700,
            letterSpacing: '1.5px',
          }}
        >
          {n.num}
        </text>
        <text
          x={16}
          y={43}
          style={{ fill: 'var(--text-title)', fontSize: '14.5px', fontWeight: 600 }}
        >
          {clip(cap1(n.title), 24)}
        </text>
        {n.tag && (
          <text
            x={16}
            y={57}
            style={{ fill: 'var(--text-muted)', fontSize: '10.5px', letterSpacing: '0.3px' }}
          >
            {clip(n.tag, 30)}
          </text>
        )}
      </g>
    </g>
  );
}

// --- main stepper ------------------------------------------------------------

function Diagram({
  layout,
  title,
  intro,
}: {
  layout: Layout;
  title?: string | undefined;
  intro?: string | undefined;
}) {
  const mk = useId().replace(/:/g, '');
  const total = layout.narr.length;
  const [step, setStep] = useState(0);
  const [auto, setAuto] = useState(true);

  useEffect(() => {
    if (!auto || step >= total - 1) return;
    const id = setTimeout(() => setStep((s) => Math.min(s + 1, total - 1)), STEP_MS);
    return () => clearTimeout(id);
  }, [auto, step, total]);

  const take = (fn: () => void) => {
    setAuto(false);
    fn();
  };

  const cur = layout.narr[Math.min(step, total - 1)] ?? { title: '', text: '' };
  const atEnd = step >= total - 1;

  return (
    <div>
      {(title || intro) && (
        <div style={{ marginBottom: '1rem' }}>
          {title && (
            <div style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-title)' }}>
              {cap1(title)}
            </div>
          )}
          {intro && (
            <div
              style={{
                fontSize: '0.78rem',
                color: 'var(--text-muted)',
                marginTop: '0.15rem',
                lineHeight: 1.4,
              }}
            >
              {intro}
            </div>
          )}
        </div>
      )}

      <svg
        viewBox={`0 0 ${layout.w} ${layout.h}`}
        width="100%"
        preserveAspectRatio="xMidYMid meet"
        style={{
          height: 'auto',
          maxWidth: layout.w,
          display: 'block',
          margin: '0 auto',
          overflow: 'visible',
        }}
        role="img"
        aria-label="Step-by-step explainer"
      >
        <defs>
          <marker
            id={`${mk}-arrow`}
            markerWidth="8"
            markerHeight="8"
            refX="4"
            refY="4"
            orient="auto"
          >
            <circle cx="4" cy="4" r="2.4" fill="var(--accent-primary)" />
          </marker>
        </defs>

        {/* connector strings */}
        {layout.edges.map((e, i) => {
          const shown = e.revealAt <= step;
          return (
            <g key={`e${i}`}>
              <path
                d={e.d}
                fill="none"
                stroke={shown ? 'var(--accent-primary)' : 'var(--border-subtle)'}
                strokeOpacity={shown ? 0.85 : 0.5}
                strokeWidth={1.75}
                pathLength={1}
                strokeDasharray={1}
                strokeDashoffset={shown ? 0 : 1}
                markerEnd={`url(#${mk}-arrow)`}
                style={{ transition: 'stroke-dashoffset 0.9s ease, stroke 0.4s ease' }}
              />
              {e.label && shown && (
                <g>
                  <rect
                    x={e.mx - (e.label.length * 5.4 + 10) / 2}
                    y={e.my - 9}
                    width={e.label.length * 5.4 + 10}
                    height={17}
                    rx={4}
                    fill="var(--bg-card)"
                    stroke="var(--border-subtle)"
                    strokeWidth={1}
                  />
                  <text
                    x={e.mx}
                    y={e.my + 3}
                    textAnchor="middle"
                    style={{ fill: 'var(--text-muted)', fontSize: '10px', fontWeight: 600 }}
                  >
                    {e.label}
                  </text>
                </g>
              )}
            </g>
          );
        })}

        {/* nodes */}
        {layout.nodes.map((n) => (
          <Node key={n.id} n={n} shown={n.revealAt <= step} active={n.revealAt === step} />
        ))}
      </svg>

      {/* narration caption box */}
      <div
        style={{
          minHeight: '3rem',
          marginTop: '1.1rem',
          borderLeft: '3px solid var(--accent-primary)',
          background: 'var(--bg-app)',
          borderRadius: '0 8px 8px 0',
          padding: '0.7rem 1rem',
        }}
      >
        <div
          style={{
            fontSize: '0.65rem',
            fontWeight: 700,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            color: 'var(--text-muted)',
            marginBottom: '0.25rem',
          }}
        >
          Step {Math.min(step + 1, total)} / {total}
        </div>
        <div
          key={step}
          style={{
            fontSize: '0.82rem',
            lineHeight: 1.5,
            color: 'var(--text-body)',
            animation: 'dvFade 0.55s ease',
          }}
        >
          <strong style={{ color: 'var(--text-title)' }}>{cap1(cur.title)}</strong>
          {cur.text ? ` — ${cur.text}` : ''}
        </div>
        <style>{`@keyframes dvFade { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }`}</style>
      </div>

      {/* controls */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '0.75rem',
          marginTop: '0.75rem',
        }}
      >
        <div style={{ display: 'flex', gap: 7, alignItems: 'center' }}>
          {layout.narr.map((_, i) => (
            <button
              key={i}
              onClick={() => take(() => setStep(i))}
              aria-label={`Step ${i + 1}`}
              style={{
                width: i === step ? 22 : 8,
                height: 8,
                padding: 0,
                border: 0,
                borderRadius: 99,
                cursor: 'pointer',
                background:
                  i === step
                    ? 'var(--accent-primary)'
                    : i < step
                      ? 'var(--text-muted)'
                      : 'var(--border-subtle)',
                transition: 'all 0.3s ease',
              }}
            />
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          <button
            onClick={() => take(() => setStep((s) => Math.max(0, s - 1)))}
            disabled={step === 0}
            className="btn btn-secondary"
            style={{ padding: '0.25rem 0.45rem', display: 'flex', opacity: step === 0 ? 0.45 : 1 }}
            aria-label="Previous step"
          >
            <ChevronLeft size={15} />
          </button>
          {atEnd ? (
            <button
              onClick={() => take(() => setStep(0))}
              className="btn btn-secondary"
              style={{ padding: '0.25rem 0.45rem', display: 'flex' }}
              aria-label="Replay"
            >
              <RotateCcw size={15} />
            </button>
          ) : (
            <button
              onClick={() => take(() => setStep((s) => Math.min(total - 1, s + 1)))}
              className="btn btn-primary"
              style={{ padding: '0.25rem 0.45rem', display: 'flex' }}
              aria-label="Next step"
            >
              <ChevronRight size={15} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// --- entry -------------------------------------------------------------------

export function DiagramView({ spec }: { spec: DiagramSpec }) {
  if (!spec || spec.none || !spec.nodes?.length || spec.nodes.length < 2) return null;
  const layout = layoutExplainer(spec);
  if (layout.narr.length === 0) return null;
  return <Diagram layout={layout} title={spec.title} intro={spec.intro} />;
}
