import { BrandLogo } from './BrandLogo';

/**
 * Centred brand lockup used on the auth screens: the emblem above the
 * "Looplet Accounting" wordmark set in the cursive script face.
 */
export function BrandHeader() {
  return (
    <div className="auth-brand">
      <div className="auth-brand__logo">
        <BrandLogo size={52} />
      </div>
      <h1 className="auth-brand__title">Looplet Accounting</h1>
      <p className="auth-brand__subtitle">Job-costed AP/AR for trades businesses</p>
    </div>
  );
}
