import type { CSSProperties } from 'react';

/**
 * Looplet mark — the rounded "L" tile used by the Looplet sign-in theme. It is an inline SVG so it scales to any
 * size, and it themes through `--brand-tile-bg` / `--brand-tile-fg` (navy and pale blue in light mode, charcoal and
 * light grey in dark mode). `glow` is kept for compatibility and adds a soft shadow.
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
      role="img"
      aria-label="Looplet logo"
      className={className}
      style={{ filter: glow ? 'drop-shadow(0 4px 10px var(--shadow-drop))' : undefined, ...style }}
    >
      <rect width="100" height="100" rx="32" fill="var(--brand-tile-bg)" />
      <text
        x="50"
        y="54"
        textAnchor="middle"
        dominantBaseline="middle"
        fontFamily="'Segoe UI', system-ui, -apple-system, sans-serif"
        fontSize="62"
        fontWeight="500"
        fill="var(--brand-tile-fg)"
      >
        L
      </text>
    </svg>
  );
}
