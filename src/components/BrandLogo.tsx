import type { CSSProperties } from 'react';

/**
 * Looplet emblem — two tall orbital ellipses crossing inside a ring, rendered as
 * a crisp inline SVG so it scales to any size and themes via `currentColor`
 * (defaults to the accent colour with a soft glow, matching the brand mark).
 */
export function BrandLogo({
  size = 48,
  glow = true,
  style,
  className,
}: {
  size?: number;
  glow?: boolean;
  style?: CSSProperties;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      role="img"
      aria-label="Looplet logo"
      className={className}
      style={{
        color: 'var(--accent-primary)',
        filter: glow ? 'drop-shadow(0 0 5px rgba(99, 102, 241, 0.45))' : undefined,
        ...style,
      }}
    >
      {/* Outer ring with a small open gap at the top-right, where a band weaves through
          (matches the brand mark). Circumference ≈ 283; dash 248 + gap 35. */}
      <circle
        cx="50"
        cy="50"
        r="45"
        stroke="currentColor"
        strokeWidth="5"
        strokeLinecap="round"
        strokeDasharray="248 35"
      />
      {/* Two wide crossing bands — the woven, globe-like emblem. */}
      <g stroke="currentColor" strokeWidth="5" fill="none" strokeLinecap="round">
        <ellipse cx="50" cy="50" rx="26" ry="43" transform="rotate(32 50 50)" />
        <ellipse cx="50" cy="50" rx="26" ry="43" transform="rotate(-32 50 50)" />
      </g>
    </svg>
  );
}
