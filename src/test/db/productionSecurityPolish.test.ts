import { readFileSync, statSync } from 'node:fs';
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

  it('keeps large dashboard merchant assets optimized as WebP thumbnails', () => {
    const dashboard = readRepoFile('src/pages/Dashboard.tsx');
    const merchantAsset = statSync(join(root, 'public/images/merchants/topup.webp'));

    expect(dashboard).toMatch(/\/images\/merchants\/topup\.webp/);
    expect(dashboard).not.toMatch(/\/images\/merchants\/[^']+\.png/);
    expect(merchantAsset.size).toBeLessThan(10_000);
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

  it('keeps Edge Function CORS origin configurable instead of permanently wildcarded', () => {
    const cors = readRepoFile('supabase/functions/_shared/cors.ts');

    expect(cors).toMatch(/Deno\.env\.get\('APP_ORIGIN'\)/);
    expect(cors).toMatch(/Deno\.env\.get\('SITE_URL'\)/);
    expect(cors).toMatch(/'Access-Control-Allow-Origin': allowedOrigin/);
    expect(cors).not.toMatch(/'Access-Control-Allow-Origin': '\*'/);
  });
});
