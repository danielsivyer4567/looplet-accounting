import { isValidElement, type CSSProperties, type ReactNode } from 'react';
import { AlertCircle, AlertTriangle, CheckCircle2, Info, type LucideIcon } from 'lucide-react';

export type AlertTone = 'info' | 'success' | 'warning' | 'danger';

const DEFAULT_ICONS: Record<AlertTone, LucideIcon> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: AlertCircle,
};

export interface AlertProps {
  tone?: AlertTone | undefined;
  title?: ReactNode | undefined;
  children?: ReactNode | undefined;
  /** A lucide icon or element; `null` hides the icon. Defaults by tone. */
  icon?: LucideIcon | ReactNode | null | undefined;
  /** Buttons or links shown after the message. */
  actions?: ReactNode | undefined;
  /** Defaults to "alert" for warning/danger and "status" otherwise. */
  role?: 'alert' | 'status' | 'note' | undefined;
  className?: string | undefined;
  style?: CSSProperties | undefined;
}

function renderIcon(icon: AlertProps['icon'], tone: AlertTone): ReactNode {
  if (icon === null) return null;
  if (icon === undefined) {
    const Icon = DEFAULT_ICONS[tone];
    return <Icon size={16} />;
  }
  if (isValidElement(icon)) return icon;
  const Icon = icon as LucideIcon;
  return <Icon size={16} />;
}

/**
 * An inline message block (the old per-page "Banner"): tinted background, tone icon, optional
 * title and actions. Warnings and problems are announced; information is not interruptive.
 */
export function Alert({
  tone = 'info',
  title,
  children,
  icon,
  actions,
  role,
  className,
  style,
}: AlertProps) {
  const liveRole = role ?? (tone === 'warning' || tone === 'danger' ? 'alert' : 'status');
  const classes = ['alert', `alert-${tone}`, className ?? ''].filter(Boolean).join(' ');
  const iconNode = renderIcon(icon, tone);
  return (
    <div className={classes} role={liveRole} style={style}>
      {iconNode ? (
        <span className="alert-icon" aria-hidden="true">
          {iconNode}
        </span>
      ) : null}
      <div className="alert-body">
        {title ? <p className="alert-title">{title}</p> : null}
        {children ? <div className="alert-message">{children}</div> : null}
        {actions ? <div className="alert-actions">{actions}</div> : null}
      </div>
    </div>
  );
}
