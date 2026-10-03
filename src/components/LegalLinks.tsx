import { Link } from 'react-router-dom';
import { LEGAL_PATHS } from '@/lib/legal';

/** Links to the privacy policy, terms of service and collection notice. */
export function LegalLinks({
  compact = false,
  className,
}: {
  compact?: boolean;
  className?: string;
}) {
  const linkStyle = { color: 'inherit', textDecoration: 'underline' } as const;
  return (
    <nav
      aria-label="Legal"
      className={className}
      style={{
        display: 'flex',
        flexDirection: compact ? 'column' : 'row',
        flexWrap: 'wrap',
        justifyContent: 'center',
        alignItems: 'center',
        gap: compact ? '0.2rem' : '0.75rem',
        fontSize: compact ? '8px' : '0.75rem',
        color: 'var(--text-muted)',
      }}
    >
      <Link to={LEGAL_PATHS.privacy} style={linkStyle}>
        {compact ? 'Privacy' : 'Privacy policy'}
      </Link>
      <Link to={LEGAL_PATHS.terms} style={linkStyle}>
        {compact ? 'Terms' : 'Terms of service'}
      </Link>
      <Link to={LEGAL_PATHS.collectionNotice} style={linkStyle}>
        {compact ? 'Collection' : 'Collection notice'}
      </Link>
    </nav>
  );
}
