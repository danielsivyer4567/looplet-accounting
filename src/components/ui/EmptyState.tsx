import { isValidElement, type CSSProperties, type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

export interface EmptyStateProps {
  /** One line saying what is not here yet, e.g. "No bills yet". */
  title?: ReactNode | undefined;
  /** Why it is empty or what to do next; plain text or elements. */
  children?: ReactNode | undefined;
  icon?: LucideIcon | ReactNode | undefined;
  /** A button or link that fills the gap. */
  action?: ReactNode | undefined;
  /** Less padding, for a table cell or a card section. */
  compact?: boolean | undefined;
  className?: string | undefined;
  style?: CSSProperties | undefined;
}

function renderIcon(icon: EmptyStateProps['icon']): ReactNode {
  if (!icon) return null;
  if (isValidElement(icon)) return icon;
  const Icon = icon as LucideIcon;
  return <Icon size={28} strokeWidth={1.5} />;
}

/**
 * What a list, table or panel shows when it has nothing to show: a dashed, centred, muted block.
 * It is ordinary content, not a live region: it mounts with its text, so there is no change for
 * a live region to announce, and pages keep `role="status"` for their own save/refusal messages.
 */
export function EmptyState({
  title,
  children,
  icon,
  action,
  compact,
  className,
  style,
}: EmptyStateProps) {
  const classes = ['empty-state', compact ? 'empty-state-compact' : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  return (
    <div className={classes} data-empty-state="" style={style}>
      {icon ? (
        <div className="empty-state-icon" aria-hidden="true">
          {renderIcon(icon)}
        </div>
      ) : null}
      {title ? <p className="empty-state-title">{title}</p> : null}
      {children ? <div className="empty-state-body">{children}</div> : null}
      {action ? <div className="empty-state-action">{action}</div> : null}
    </div>
  );
}
