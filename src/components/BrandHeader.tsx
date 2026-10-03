/**
 * Card header for the auth screens, in the Looplet sign-in style: a small product eyebrow above the screen heading.
 * The "L" mark itself sits in the page's top bar (see AuthShell), so it is not repeated here.
 */
export function BrandHeader() {
  return (
    <div className="auth-brand">
      <p className="auth-eyebrow">Looplet Accounting</p>
    </div>
  );
}
