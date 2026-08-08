import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Missing config must NOT crash the module graph: doing so breaks vi.mock()
// interception in tests and, in the browser, takes down ErrorBoundary before
// the user ever sees a helpful message. Warn loudly instead; the client will
// fail on the first real auth call, which surfaces the same cause without the
// import-time nuke.
const MISSING_CONFIG = !url || !anonKey;
if (MISSING_CONFIG) {
  console.error(
    'Missing Supabase config: set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env.local',
  );
}

/**
 * Frontend Supabase client. Uses the anon key + RLS for tenant isolation.
 * Never expose the service-role key to this client.
 *
 * Note: untyped (no Database generic) until `npm run supabase:types` is
 * run against the live schema. Once that lands, swap to:
 *   import type { Database } from './database.types';
 *   createClient<Database>(...)
 * and the rest of the codebase gets full row/insert/update types for free.
 */
export const supabase = createClient(url ?? '', anonKey ?? '', {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});
