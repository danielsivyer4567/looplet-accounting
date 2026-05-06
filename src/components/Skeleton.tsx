/**
 * Skeleton loading primitives.
 *
 * All use a pure-CSS gradient pulse so there is zero JS animation overhead.
 * Colours match the dark palette: card bg #1a1a1a, border #2a2a2a.
 */

import React from 'react';

// ---------------------------------------------------------------------------
// Shared keyframe injected once into <head>
// ---------------------------------------------------------------------------

let _injected = false;
function injectKeyframes() {
  if (_injected || typeof document === 'undefined') return;
  _injected = true;
  const style = document.createElement('style');
  style.textContent = `
    @keyframes skeleton-pulse {
      0%   { background-position: 200% center; }
      100% { background-position: -200% center; }
    }
  `;
  document.head.appendChild(style);
}

injectKeyframes();

// ---------------------------------------------------------------------------
// Base shimmer style
// ---------------------------------------------------------------------------

const shimmer: React.CSSProperties = {
  background: 'linear-gradient(90deg, #1a1a1a 25%, #252525 50%, #1a1a1a 75%)',
  backgroundSize: '400% 100%',
  animation: 'skeleton-pulse 1.6s ease-in-out infinite',
  borderRadius: 4,
};

// ---------------------------------------------------------------------------
// SkeletonLine — single placeholder bar
// ---------------------------------------------------------------------------

interface SkeletonLineProps {
  width?: string | number;
  height?: string | number;
}

export function SkeletonLine({ width = '100%', height = 14 }: SkeletonLineProps) {
  return (
    <div
      style={{
        ...shimmer,
        width,
        height,
        display: 'block',
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// SkeletonCard — matches KPI card dimensions (~120px tall, full grid column)
// ---------------------------------------------------------------------------

export function SkeletonCard() {
  return (
    <div
      style={{
        padding: '1rem',
        background: '#1a1a1a',
        borderRadius: 6,
        border: '1px solid #2a2a2a',
        minHeight: 100,
        display: 'flex',
        flexDirection: 'column',
        gap: '0.5rem',
      }}
    >
      {/* label line */}
      <SkeletonLine width="55%" height={10} />
      {/* value line */}
      <SkeletonLine width="70%" height={26} />
      {/* optional hint line */}
      <SkeletonLine width="40%" height={10} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// SkeletonTable — table-shaped placeholder
// ---------------------------------------------------------------------------

interface SkeletonTableProps {
  rows?: number;
  cols?: number;
}

export function SkeletonTable({ rows = 5, cols = 5 }: SkeletonTableProps) {
  // Column widths cycle through a few sizes to look realistic
  const colWidths = ['30%', '20%', '15%', '15%', '20%'];

  return (
    <div style={{ width: '100%' }}>
      {/* Header row */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${cols}, 1fr)`,
          gap: '0.5rem',
          paddingBottom: '0.75rem',
          borderBottom: '1px solid #2a2a2a',
          marginBottom: '0.5rem',
        }}
      >
        {Array.from({ length: cols }).map((_, i) => (
          <SkeletonLine
            key={i}
            width={colWidths[i % colWidths.length]}
            height={10}
          />
        ))}
      </div>
      {/* Body rows */}
      {Array.from({ length: rows }).map((_, rowIdx) => (
        <div
          key={rowIdx}
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${cols}, 1fr)`,
            gap: '0.5rem',
            padding: '0.6rem 0',
            borderBottom: '1px solid #1a1a1a',
          }}
        >
          {Array.from({ length: cols }).map((_, colIdx) => {
            // Vary widths between rows so it looks natural
            const variance = (rowIdx * 7 + colIdx * 13) % 30;
            return (
              <SkeletonLine
                key={colIdx}
                width={`${50 + variance}%`}
                height={13}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}
