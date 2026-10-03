import { isValidElement, type CSSProperties, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { AnimatedNumber } from '@/components/AnimatedNumber';

/** Semantic tones shared by Stat, StatusBadge and Alert; each maps to the --accent-* / badge-* tokens. */
export type Tone = 'primary' | 'success' | 'danger' | 'warning' | 'info' | 'neutral';

export interface StatProps {
  label: ReactNode;
  /** A number animates (see AnimatedNumber); a string renders as given. */
  value: number | string;
  /**
   * card: the KPI tile with a coloured left border and an icon (default).
   * inline: label over value with no box, for detail-page summaries.
   * tile: a small bordered box, for metric grids inside a card.
   */
  variant?: 'card' | 'inline' | 'tile' | undefined;
  /** Colours the card's left border and icon; neutral falls back to the primary accent. */
  tone?: Tone | undefined;
  /** An explicit token (for example `var(--accent-info)`) that overrides `tone`. */
  accentColor?: string | undefined;
  /** A lucide icon component or any element; decorative, so hidden from assistive tech. */
  icon?: LucideIcon | ReactNode | undefined;
  /** Small line under the value (a note, a period, a partial-total warning). */
  sub?: ReactNode | undefined;
  /** Formats a numeric `value`; defaults to en-AU grouping. */
  formatter?: ((value: number) => string) | undefined;
  /** inline: show the value in the title colour rather than the body colour. */
  strong?: boolean | undefined;
  /** Monospace value (ABNs, BSBs, references). */
  mono?: boolean | undefined;
  className?: string | undefined;
  style?: CSSProperties | undefined;
}

function accentFor(tone: Tone | undefined, accentColor: string | undefined): string {
  if (accentColor) return accentColor;
  const t = tone && tone !== 'neutral' ? tone : 'primary';
  return `var(--accent-${t})`;
}

function renderIcon(icon: StatProps['icon']): ReactNode {
  if (!icon) return null;
  if (isValidElement(icon)) return icon;
  if (typeof icon === 'function' || (typeof icon === 'object' && icon !== null && 'render' in icon)) {
    const Icon = icon as LucideIcon;
    return <Icon size={18} />;
  }
  return icon as ReactNode;
}

/**
 * One number with its label: the KPI card at the top of a page, an inline summary on a
 * detail page, or a metric tile. Labelled as a group so "Total billed, $1,200" reads as one
 * thing to assistive tech.
 */
export function Stat({
  label,
  value,
  variant = 'card',
  tone,
  accentColor,
  icon,
  sub,
  formatter,
  strong,
  mono,
  className,
  style,
}: StatProps) {
  const accent = accentFor(tone, accentColor);
  const labelText = typeof label === 'string' ? label : undefined;
  const classes = ['stat', `stat-${variant}`, strong ? 'stat-strong' : '', mono ? 'stat-mono' : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  const cardStyle: CSSProperties =
    variant === 'card' ? { borderLeftColor: accent, ...style } : { ...style };

  return (
    <div className={classes} role="group" aria-label={labelText} style={cardStyle}>
      <span className="stat-label">{label}</span>
      <strong className="stat-value">
        {typeof value === 'number' ? <AnimatedNumber value={value} formatter={formatter} /> : value}
      </strong>
      {variant === 'card' ? (
        // Keep the card height stable whether or not there is a sub line.
        <span className="stat-sub">{sub ?? ' '}</span>
      ) : sub ? (
        <span className="stat-sub">{sub}</span>
      ) : null}
      {variant === 'card' && icon ? (
        <span className="stat-icon" style={{ color: accent }} aria-hidden="true">
          {renderIcon(icon)}
        </span>
      ) : null}
    </div>
  );
}
