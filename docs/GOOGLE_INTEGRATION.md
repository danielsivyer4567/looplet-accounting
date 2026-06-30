# Google Integration

Date: 2026-06-30

Looplet uses Google in two separate ways:

1. **Google sign-in** through Supabase Auth.
2. **Google document intake** through Gmail OAuth, which imports PDF/image
   attachments into `bills` and dispatches `bills-extract`.

## Google Sign-In

Frontend entry points:

- `src/contexts/AuthContext.tsx`
- `src/pages/Login.tsx`
- `src/pages/Signup.tsx`

Supabase must have the Google provider enabled:

- Supabase Dashboard -> Authentication -> Providers -> Google.
- Google OAuth client callback URL:
  `https://<project-ref>.supabase.co/auth/v1/callback`.
- Supabase redirect allow-list must include each deployed app origin plus:
  - `http://localhost:5173/login?oauth=google`
  - `https://<preview-or-production-origin>/login?oauth=google`

The app calls:

```ts
supabase.auth.signInWithOAuth({
  provider: 'google',
  options: {
    redirectTo: `${window.location.origin}/login?oauth=google`,
    queryParams: { prompt: 'select_account' },
  },
});
```

After Supabase detects the OAuth session in the URL, `LoginPage` redirects the
signed-in user back to `/`.

## Google Document Intake

Frontend entry points:

- `src/components/settings/GmailConnect.tsx`
- `src/pages/BillUpload.tsx`
- `src/pages/GmailCallback.tsx`

Edge functions:

- `gmail-oauth-start`
- `gmail-oauth-callback`
- `gmail-backfill`
- `gmail-pubsub-push`
- `gmail-watch-renew`
- `bills-extract`

Required Supabase function secrets:

- `GMAIL_CLIENT_ID`
- `GMAIL_CLIENT_SECRET`
- `GMAIL_PUBSUB_TOPIC`
- `GMAIL_PUSH_VERIFY_TOKEN`
- `GMAIL_WATCH_RENEW_CRON_SECRET`
- `ENCRYPTION_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

Google OAuth scope for document intake:

- `https://www.googleapis.com/auth/gmail.readonly`

The Gmail pipeline:

1. User connects a Google mailbox from Settings or Upload bill.
2. `gmail-oauth-start` returns the Google consent URL.
3. `gmail-oauth-callback` stores encrypted Gmail tokens and registers
   `users.watch()`.
4. `gmail-backfill` scans recent inbox messages with attachments.
5. Gmail PDF/image attachments are uploaded to the private `bills` bucket.
6. A `bills` row is inserted with `source='gmail'`.
7. `bills-extract` runs OCR/text extraction and leaves low-confidence items for
   review.

## Current Boundary

This is Gmail attachment intake, not Google Drive Picker import. If direct Drive
file selection is needed later, add a separate Drive OAuth scope, picker UI, and
server-side download function instead of expanding the Gmail token scope
silently.
