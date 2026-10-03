import { useId, type CSSProperties, type ReactNode } from 'react';
import { AnimatedNumber } from './AnimatedNumber';

export type InsightTone = 'primary' | 'success' | 'warning' | 'danger' | 'info' | 'neutral';

export interface InsightDatum {
  label: string;
  value: number;
  tone?: InsightTone;
  detail?: string;
  displayValue?: string;
}

export interface MindMapBranch {
  title: string;
  detail: string;
  tone?: InsightTone;
}

export interface InsightLineSeries {
  label: string;
  items: InsightDatum[];
  tone?: InsightTone;
}

const toneColor: Record<InsightTone, string> = {
  primary: 'var(--accent-primary)',
  success: 'var(--accent-success)',
  warning: 'var(--accent-warning)',
  danger: 'var(--accent-danger)',
  info: 'var(--accent-info)',
  neutral: 'var(--text-muted)',
};

const subtleBg: Record<InsightTone, string> = {
  primary: 'var(--accent-primary-tint)',
  success: 'var(--bg-success-subtle)',
  warning: 'var(--bg-warning-subtle)',
  danger: 'var(--bg-danger-subtle)',
  info: 'var(--bg-info-subtle)',
  neutral: 'var(--bg-hover)',
};

function fmtPercent(value: number, total: number) {
  if (total <= 0) return '0%';
  return `${Math.round((Math.abs(value) / total) * 100)}%`;
}

function defaultFormat(value: number) {
  return value.toLocaleString('en-AU');
}

function activeItems(items: InsightDatum[]) {
  return items.filter((item) => Number.isFinite(item.value) && Math.abs(item.value) > 0);
}

function chartCoordinates(items: InsightDatum[], domainValues?: number[]) {
  const width = 420;
  const height = 168;
  const xPad = 14;
  const yPad = 20;
  const values = domainValues?.length
    ? domainValues
    : items.length
      ? items.map((item) => item.value)
      : [0];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || Math.max(Math.abs(max), 1);
  const y = (value: number) => height - yPad - ((value - min) / range) * (height - yPad * 2);

  return items.map((item, index) => ({
    ...item,
    x: items.length <= 1 ? width / 2 : xPad + (index / (items.length - 1)) * (width - xPad * 2),
    y: y(item.value),
  }));
}

function smoothPath(points: { x: number; y: number }[]) {
  const first = points[0];
  if (!first) return '';
  if (points.length === 1) return `M ${first.x} ${first.y}`;
  return points.reduce((path, point, index) => {
    if (index === 0) return `M ${point.x} ${point.y}`;
    const previous = points[index - 1] ?? first;
    const midX = (previous.x + point.x) / 2;
    return `${path} C ${midX} ${previous.y}, ${midX} ${point.y}, ${point.x} ${point.y}`;
  }, '');
}

export function InsightPanel({
  title,
  eyebrow,
  children,
  style,
}: {
  title: string;
  eyebrow?: string;
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <section className="insight-panel" style={style}>
      <div style={{ marginBottom: '1rem' }}>
        {eyebrow ? <div className="insight-eyebrow">{eyebrow}</div> : null}
        <h2 className="insight-title">{title}</h2>
      </div>
      {children}
    </section>
  );
}

export function InsightAreaChart({
  title,
  items,
  tone = 'success',
  series = [],
  markerLabel,
  formatValue = defaultFormat,
}: {
  title?: string;
  items: InsightDatum[];
  tone?: InsightTone;
  series?: InsightLineSeries[];
  markerLabel?: string;
  formatValue?: (value: number) => string;
}) {
  const chartId = useId().replace(/:/g, '');
  const primaryItems = items.filter((item) => Number.isFinite(item.value));
  const domainValues = [
    ...primaryItems.map((item) => item.value),
    ...series.flatMap((lineSeries) =>
      lineSeries.items.map((item) => item.value).filter(Number.isFinite),
    ),
  ];
  const points = chartCoordinates(primaryItems, domainValues);
  const line = smoothPath(points);
  const first = points[0];
  const last = points[points.length - 1];
  const area = line && last && first ? `${line} L ${last.x} 168 L ${first.x} 168 Z` : '';
  const referenceY = points.length
    ? points.reduce((sum, point) => sum + point.y, 0) / points.length
    : 84;
  const color = toneColor[tone];
  const secondarySeries = series
    .map((lineSeries) => ({
      ...lineSeries,
      points: chartCoordinates(
        lineSeries.items.filter((item) => Number.isFinite(item.value)),
        domainValues,
      ),
      color: toneColor[lineSeries.tone ?? 'info'],
    }))
    .filter((lineSeries) => lineSeries.points.length > 1);

  return (
    <div
      className="insight-area"
      style={{ '--area-color': color } as CSSProperties}
      role="img"
      aria-label={`${title ?? 'Trend'} line chart`}
    >
      <div className="insight-area-meta">
        <span>{title ?? 'Signal'}</span>
        <strong>
          {last ? <AnimatedNumber value={last.value} formatter={formatValue} /> : formatValue(0)}
        </strong>
      </div>
      <svg
        className="insight-area-svg"
        viewBox="0 0 420 168"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id={`${chartId}-line`} x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor={color} stopOpacity="0.34" />
            <stop offset="42%" stopColor={color} stopOpacity="1" />
            <stop offset="100%" stopColor={color} stopOpacity="0.12" />
          </linearGradient>
          <linearGradient id={`${chartId}-fill`} x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor={color} stopOpacity="0.28" />
            <stop offset="58%" stopColor={color} stopOpacity="0.08" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
          <filter id={`${chartId}-glow`} x="-10%" y="-40%" width="120%" height="180%">
            <feGaussianBlur stdDeviation="4" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <path className="insight-area-fill" d={area} fill={`url(#${chartId}-fill)`} />
        <line className="insight-area-reference" x1="14" y1={referenceY} x2="406" y2={referenceY} />
        {secondarySeries.map((lineSeries, index) => (
          <path
            key={`${lineSeries.label}-${index}`}
            className="insight-area-line insight-area-line-secondary"
            d={smoothPath(lineSeries.points)}
            stroke={lineSeries.color}
            pathLength={1}
          />
        ))}
        <path className="insight-area-glow" d={line} stroke={color} />
        <path
          className="insight-area-line"
          d={line}
          stroke={`url(#${chartId}-line)`}
          pathLength={1}
        />
        {last ? (
          <>
            <circle
              className="insight-area-end-glow"
              cx={last.x}
              cy={last.y}
              r="13"
              fill={color}
              style={{ '--end-x': last.x, '--end-y': last.y } as CSSProperties}
            />
            <circle
              className="insight-area-end"
              cx={last.x}
              cy={last.y}
              r="4.5"
              fill={color}
              style={{ '--end-x': last.x, '--end-y': last.y } as CSSProperties}
            />
          </>
        ) : null}
      </svg>
      {last ? (
        <div className="insight-area-pill">
          {markerLabel ?? last.label}
          <span>{formatValue(last.value)}</span>
        </div>
      ) : null}
      {secondarySeries.length > 0 ? (
        <div className="insight-area-series">
          <span style={{ '--series-color': color } as CSSProperties}>{title ?? 'Primary'}</span>
          {secondarySeries.slice(0, 2).map((lineSeries) => (
            <span
              key={lineSeries.label}
              style={{ '--series-color': lineSeries.color } as CSSProperties}
            >
              {lineSeries.label}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function InsightDonutChart({
  title,
  items,
  centerLabel,
  centerValue,
  formatValue = defaultFormat,
}: {
  title?: string;
  items: InsightDatum[];
  centerLabel?: string;
  centerValue?: string;
  formatValue?: (value: number) => string;
}) {
  const chartId = useId().replace(/:/g, '');
  const filtered = activeItems(items);
  const total = filtered.reduce((sum, item) => sum + Math.abs(item.value), 0);
  const radius = 76;
  const circumference = 2 * Math.PI * radius;
  const gap = filtered.length > 1 ? 4 : 0;
  let offset = 0;
  const segments = filtered.map((item) => {
    const length = total > 0 ? (Math.abs(item.value) / total) * circumference : 0;
    const segment = {
      item,
      dash: Math.max(length - gap, 0),
      offset,
    };
    offset += length;
    return segment;
  });

  return (
    <div className="insight-chart-grid">
      <div className="insight-donut-wrap">
        <div
          className="insight-donut"
          role="img"
          aria-label={`${title ?? centerLabel ?? 'Insight'} donut chart`}
        >
          <svg className="insight-donut-svg" viewBox="0 0 200 200" aria-hidden="true">
            <defs>
              <filter id={`${chartId}-soft-shadow`} x="-20%" y="-20%" width="140%" height="140%">
                <feDropShadow dx="0" dy="10" stdDeviation="7" floodColor="var(--shadow-drop)" />
              </filter>
            </defs>
            <circle className="insight-donut-track" cx="100" cy="100" r={radius} />
            {segments.map(({ item, dash, offset: segmentOffset }) => (
              <circle
                key={item.label}
                className="insight-donut-segment"
                cx="100"
                cy="100"
                r={radius}
                stroke={toneColor[item.tone ?? 'primary']}
                strokeDasharray={`${dash} ${circumference - dash}`}
                strokeDashoffset={-segmentOffset}
                filter={`url(#${chartId}-soft-shadow)`}
              />
            ))}
          </svg>
          <div className="insight-donut-core">
            <span>{centerLabel ?? 'Total'}</span>
            <strong>
              {centerValue ?? <AnimatedNumber value={total} formatter={formatValue} />}
            </strong>
          </div>
        </div>
      </div>
      <div className="insight-legend">
        {title ? <h3>{title}</h3> : null}
        {(filtered.length > 0 ? filtered : items).map((item) => {
          const tone = item.tone ?? 'primary';
          const formatted = item.displayValue ?? formatValue(item.value);
          return (
            <div
              key={item.label}
              className="insight-legend-row"
              style={{ '--tone-color': toneColor[tone] } as CSSProperties}
            >
              <span className="insight-dot" />
              <span className="insight-legend-label">{item.label}</span>
              <span className="insight-legend-metric">
                <strong>{formatted}</strong>
                <span>{fmtPercent(item.value, total)}</span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function InsightBarList({
  items,
  formatValue = defaultFormat,
}: {
  items: InsightDatum[];
  formatValue?: (value: number) => string;
}) {
  const max = Math.max(...items.map((item) => Math.abs(item.value)), 1);
  return (
    <div className="insight-bars">
      {items.map((item, index) => {
        const tone = item.tone ?? 'primary';
        const width = `${Math.max((Math.abs(item.value) / max) * 100, item.value === 0 ? 0 : 6)}%`;
        return (
          <div
            key={item.label}
            className="insight-bar-row"
            style={
              {
                '--bar-color': toneColor[tone],
                '--bar-width': width,
                '--bar-index': index,
              } as CSSProperties
            }
          >
            <div className="insight-bar-header">
              <span>
                <i aria-hidden="true" />
                {item.label}
              </span>
              <strong>
                <AnimatedNumber value={item.value} formatter={formatValue} />
              </strong>
            </div>
            <div className="insight-bar-track">
              <div className="insight-bar-fill" />
              <span className="insight-bar-marker" />
            </div>
            {item.detail ? <p>{item.detail}</p> : null}
          </div>
        );
      })}
    </div>
  );
}

export function TopDownMindMap({ root, branches }: { root: string; branches: MindMapBranch[] }) {
  return (
    <div className="mind-map" role="img" aria-label="Top-down explanation mind map">
      <div className="mind-map-root">
        <span>Reasoning map</span>
        <strong>{root}</strong>
      </div>
      <div className="mind-map-stem" />
      <div className="mind-map-branches">
        {branches.map((branch, index) => {
          const tone = branch.tone ?? 'primary';
          return (
            <div
              key={branch.title}
              className="mind-map-node"
              style={
                { '--node-color': toneColor[tone], '--node-bg': subtleBg[tone] } as CSSProperties
              }
            >
              <span className="mind-map-index">{String(index + 1).padStart(2, '0')}</span>
              <strong>{branch.title}</strong>
              <span className="mind-map-detail">{branch.detail}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
