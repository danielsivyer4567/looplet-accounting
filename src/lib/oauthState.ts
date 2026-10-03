// Browser half of the OAuth CSRF check for the Xero and Gmail connect flows.
//
// When this tab starts a connection it stores the state the server issued. The callback page only continues when the
// provider returns that same state; a callback link that arrives without one (for example a link someone else sent)
// is refused. The server separately checks that the state is signed for this user and organisation.

export type OAuthStateKey = 'xero_oauth_state' | 'gmail_oauth_state';

export type OAuthStateResult = { ok: true } | { ok: false; error: string };

export function rememberOAuthState(key: OAuthStateKey, state: string): void {
  sessionStorage.setItem(key, state);
}

/** Checks the returned state against the stored one and removes the stored copy, so it can be used only once. */
export function consumeOAuthState(key: OAuthStateKey, returned: string | null): OAuthStateResult {
  let stored: string | null = null;
  try {
    stored = sessionStorage.getItem(key);
    sessionStorage.removeItem(key);
  } catch {
    stored = null;
  }
  if (!returned) {
    return {
      ok: false,
      error:
        'The sign-in provider did not return a state. Please start the connection again from Settings.',
    };
  }
  if (!stored) {
    return {
      ok: false,
      error:
        'This connection was not started in this browser tab. For your security, start it again from Settings.',
    };
  }
  if (stored !== returned) {
    return {
      ok: false,
      error:
        'This response does not match the connection started here. For your security, start it again from Settings.',
    };
  }
  return { ok: true };
}
