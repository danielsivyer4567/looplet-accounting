import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

function readRepoFile(relativePath: string): string {
  return readFileSync(join(root, relativePath), 'utf8');
}

describe('production security and performance polish', () => {
  it('keeps route pages split out of the initial app bundle', () => {
    const app = readRepoFile('src/App.tsx');

    expect(app).toMatch(/import \{ lazy, Suspense \} from 'react'/);
    expect(app).toMatch(/<Suspense fallback=\{<RouteFallback \/>}/);
    expect(app).toMatch(/lazy\(\(\) =>\s+import\('@\/pages\/Dashboard'\)/);
    expect(app).not.toMatch(/import \{ DashboardPage \} from '@\/pages\/Dashboard'/);

    const vite = readRepoFile('vite.config.ts');
    expect(vite).toMatch(/rolldownOptions/);
    expect(vite).toMatch(/codeSplitting/);
    expect(vite).toMatch(/react-vendor/);
    expect(vite).toMatch(/supabase-vendor/);
  });

  it('ships no mock merchant assets — the dashboard feed is real data only', () => {
    const dashboard = readRepoFile('src/pages/Dashboard.tsx');

    // The old hardcoded transaction feed shipped fake merchant thumbnails;
    // the feed now renders real bills/invoices/bank rows with initial badges.
    expect(dashboard).not.toMatch(/\/images\/merchants\//);
    expect(dashboard).not.toMatch(/mockTransactions/);
    expect(existsSync(join(root, 'public/images/merchants'))).toBe(false);
  });

  it('disables production sourcemaps and publishes baseline security headers', () => {
    const vite = readRepoFile('vite.config.ts');
    const headers = readRepoFile('public/_headers');

    expect(vite).toMatch(/sourcemap:\s*false/);
    expect(headers).toMatch(/Content-Security-Policy:/);
    expect(headers).toMatch(/frame-ancestors 'none'/);
    expect(headers).toMatch(/object-src 'none'/);
    expect(headers).toMatch(/X-Content-Type-Options: nosniff/);
    expect(headers).toMatch(/Strict-Transport-Security:/);
  });

  it('keeps Edge Function CORS origin configurable, with auth as the security boundary', () => {
    const cors = readRepoFile('supabase/functions/_shared/cors.ts');

    // Deliberate contract (see fix(cors) de7e52e): permissive default so every
    // app domain works, with CORS_ALLOWED_ORIGIN as the explicit pin. CORS must
    // never silently pin to the email SITE_URL/APP_ORIGIN again.
    expect(cors).toMatch(/Deno\.env\.get\('CORS_ALLOWED_ORIGIN'\)/);
    expect(cors).toMatch(/'Access-Control-Allow-Origin': allowedOrigin/);
    expect(cors).not.toMatch(/Deno\.env\.get\('APP_ORIGIN'\)/);
    expect(cors).not.toMatch(/Deno\.env\.get\('SITE_URL'\)/);
  });
});
