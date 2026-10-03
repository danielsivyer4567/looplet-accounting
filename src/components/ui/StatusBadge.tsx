import type { CSSProperties, ReactNode } from 'react';
import type { Tone } from '@/components/ui/Stat';

/**
 * How a status word reads by default. A page whose domain differs (a bill that is "paid" is
 * informational, not a success; a subscription that is "cancelled" is neutral) passes `tones`.
 */
export const DEFAULT_STATUS_TONES: Readonly<Record<string, Tone>> = {
  paid: 'success',
  exported: 'success',
  active: 'success',
  completed: 'success',
  accepted: 'success',
  attached: 'success',
  confirmed: 'success',
  linked: 'success',
  available: 'success',
  synced: 'success',
  reconciled: 'success',
  matched: 'success',
  passed: 'success',
  sent: 'info',
  submitted: 'info',
  queued: 'info',
  approved: 'info',
  issued: 'info',
  detected: 'info',
  candidate: 'info',
  processing: 'info',
  in_progress: 'info',
  scheduled: 'info',
  draft: 'warning',
  pending: 'warning',
  partially_paid: 'warning',
  paused: 'warning',
  on_hold: 'warning',
  quoted: 'warning',
  verified: 'warning',
  review_needed: 'warning',
  needs_review: 'warning',
  expired: 'warning',
  dismissed: 'warning',
  provisional: 'warning',
  overdue: 'danger',
  cancelled: 'danger',
  reversed: 'danger',
  failed: 'danger',
  rejected: 'danger',
  error: 'danger',
  void: 'danger',
  voided: 'danger',
  archived: 'danger',
  revoked: 'danger',
  blocked: 'danger',
  missing: 'danger',
};

/** "partially_paid" -> "Partially paid". */
export function humaniseStatus(status: string): string {
  const words = status.replace(/[_-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export interface StatusBadgeProps {
  status: string;
  /** Overrides the tone lookup entirely. */
  tone?: Tone | undefined;
  /** Page-specific tones merged over DEFAULT_STATUS_TONES. */
  tones?: Readonly<Partial<Record<string, Tone>>> | undefined;
  /** Text to show instead of the humanised status. */
  label?: ReactNode | undefined;
  /** Decorative leading icon. */
  icon?: ReactNode | undefined;
  className?: string | undefined;
  style?: CSSProperties | undefined;
  title?: string | undefined;
}

/** The status pill: `.badge badge-<tone>` with the status in sentence case. */
export function StatusBadge({ status, tone, tones, label, icon, className, style, title }: StatusBadgeProps) {
  const resolved: Tone = tone ?? tones?.[status] ?? DEFAULT_STATUS_TONES[status] ?? 'neutral';
  const classes = ['badge', `badge-${resolved === 'primary' ? 'info' : resolved}`, className ?? '']
    .filter(Boolean)
    .join(' ');
  return (
    <span className={classes} data-status={status} style={style} title={title}>
      {icon ? (
        <span className="badge-icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      {label ?? humaniseStatus(status)}
    </span>
  );
}
