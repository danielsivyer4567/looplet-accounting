import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { allows, parseCsp, readHeaders } from './cspPolicy';

// SEC-07 hardening contract. Behaviour of the shared Deno helpers is tested in Deno next to them
// (supabase/functions/_shared/*.test.ts); these checks hold the wiring and the static configuration.

const read = (path: string) => readFileSync(path, 'utf8');

function filesUnder(dir: string, pattern: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name).replace(/\\/g, '/');
    if (statSync(path).isDirectory())
      return name === 'node_modules' ? [] : filesUnder(path, pattern);
    return pattern.test(name) ? [path] : [];
  });
}

describe('pdf.js runs its worker from this site, not a CDN', () => {
  const csp = parseCsp(readHeaders().get('content-security-policy') ?? '');
  const users = [
    'src/components/DocumentPreviewModal.tsx',
    'src/components/settings/BankStatementImport.tsx',
  ];

  it('both PDF readers use the worker Vite bundles from the installed pdfjs-dist', () => {
    for (const file of users) {
      const src = read(file);
      expect(src, file).toContain(
        "import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';",
      );
      expect(src, file).toMatch(/GlobalWorkerOptions\.workerSrc = pdfWorkerUrl;/);
    }
  });

  it('no app code points a worker or script at a CDN', () => {
    for (const file of filesUnder('src', /\.tsx?$/).filter((f) => !f.startsWith('src/test/'))) {
      const src = read(file);
      expect(src, file).not.toMatch(/workerSrc\s*=\s*[`'"]https?:/);
      expect(src, file).not.toMatch(/(cdnjs\.cloudflare\.com|unpkg\.com|cdn\.jsdelivr\.net)/);
    }
  });

  it('the CSP lets workers and scripts load from this site only', () => {
    expect(csp.get('worker-src')).toEqual(["'self'"]);
    expect(csp.get('script-src')).toEqual(["'self'"]);
    expect(
      allows(
        csp,
        'worker-src',
        'https://accounting.looplet.com.au/assets/pdf.worker.min-abc123.mjs',
      ),
    ).toBe(true);
    for (const cdn of [
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs',
      'https://unpkg.com/pdfjs-dist@4.7.76/build/pdf.worker.min.mjs',
      'blob:https://accounting.looplet.com.au/0b1c',
    ]) {
      expect(allows(csp, 'worker-src', cdn), cdn).toBe(false);
      expect(allows(csp, 'script-src', cdn), cdn).toBe(false);
    }
  });
});

describe('CORS is an allow-list, not *', () => {
  const functionSources = filesUnder('supabase/functions', /\.ts$/).filter(
    (f) => !/\.test\.ts$/.test(f),
  );
  const entrypoints = filesUnder('supabase/functions', /^index\.ts$/).filter(
    (f) => !f.includes('/_shared/'),
  );

  it('the shared module has no wildcard default and wraps Deno.serve for per-request origins', () => {
    const cors = read('supabase/functions/_shared/cors.ts');
    expect(cors).not.toMatch(/\?\?\s*['"]\*['"]/);
    expect(cors).toContain("env.get('CORS_ALLOWED_ORIGINS')");
    expect(cors).toMatch(/^installCorsServeWrapper\(\);$/m);
    expect(cors).toContain("'https://accounting.looplet.com.au'");
  });

  it('no function sets Access-Control-Allow-Origin to * itself', () => {
    for (const file of functionSources) {
      expect(read(file), file).not.toMatch(/['"]Access-Control-Allow-Origin['"]\s*:\s*['"]\*['"]/i);
    }
  });

  it('every function that serves HTTP imports the shared CORS module (which installs the wrapper)', () => {
    const serving = entrypoints.filter((f) => /\bDeno\.serve\(/.test(read(f)));
    expect(serving.length).toBeGreaterThan(50);
    for (const file of serving) {
      expect(read(file), file).toMatch(/from ['"]\.\.\/_shared\/cors\.ts['"]/);
    }
  });
});
