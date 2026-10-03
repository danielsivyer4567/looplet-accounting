import type { CSSProperties, ReactNode } from 'react';

export interface PageHeaderProps {
  title: ReactNode;
  /** One sentence under the title saying what the page is for. */
  description?: ReactNode | undefined;
  /** Small label above the title (a section or parent name). */
  eyebrow?: ReactNode | undefined;
  /** Badges or counts shown after the title, on the same line. */
  meta?: ReactNode | undefined;
  /** Primary and secondary actions; wrap under the title on narrow screens. */
  actions?: ReactNode | undefined;
  /** Extra content below the header row (filters, tabs). */
  children?: ReactNode | undefined;
  /** Heading level; pages use h1 (default), panels inside a page use h2. */
  as?: 'h1' | 'h2' | undefined;
  className?: string | undefined;
  style?: CSSProperties | undefined;
}

/**
 * The title block at the top of a page. On its own it is just the heading (so it drops into an
 * existing toolbar row); with a description or actions it becomes the full header row and
 * takes the page's spacing below.
 */
export function PageHeader({
  title,
  description,
  eyebrow,
  meta,
  actions,
  children,
  as = 'h1',
  className,
  style,
}: PageHeaderProps) {
  const Heading = as;
  const full = Boolean(description || actions || eyebrow || children);
  const classes = ['page-header', full ? 'page-header-full' : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  return (
    <header className={classes} style={style}>
      <div className="page-header-row">
        <div className="page-header-text">
          {eyebrow ? <p className="page-header-eyebrow">{eyebrow}</p> : null}
          <Heading className="page-header-title">
            {title}
            {meta ? <span className="page-header-meta">{meta}</span> : null}
          </Heading>
          {description ? <p className="page-header-description">{description}</p> : null}
        </div>
        {actions ? <div className="page-header-actions">{actions}</div> : null}
      </div>
      {children}
    </header>
  );
}
