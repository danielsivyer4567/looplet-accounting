import { BrandLogo } from './BrandLogo';

/**
 * Centred brand lockup used on the auth screens: the emblem above the
 * "Looplet Accounting" wordmark set in the cursive script face.
 */
export function BrandHeader() {
  return (
    <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '0.85rem' }}>
        <BrandLogo size={52} />
      </div>
      <h1
        style={{
          margin: 0,
          fontFamily: 'var(--font-script)',
          fontWeight: 600,
          fontSize: '2.4rem',
          lineHeight: 1.1,
          color: 'var(--text-title)',
        }}
      >
        Looplet Accounting
      </h1>
      <p style={{ color: 'var(--text-muted)', fontSize: '0.875rem', marginTop: '0.5rem' }}>
        Job-costed AP/AR for trades businesses
      </p>
    </div>
  );
}
