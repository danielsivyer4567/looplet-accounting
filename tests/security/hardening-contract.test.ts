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

describe('secrets are compared in constant time and cron secrets travel in a header', () => {
  const sources = filesUnder('supabase/functions', /\.ts$/).filter((f) => !/\.test\.ts$/.test(f));
  const cronReceivers = [
    'accountant-orchestrator',
    'accountant-session-digest',
    'accruals-run',
    'advisor',
    'auto-reconcile',
    'automation-watchdog',
    'automation-worker',
    'bank-sync-all',
    'bank-transaction-classifier',
    'depreciation-run',
    'gmail-watch-renew',
    'legal-corpus-ingest',
    'legal-corpus-sync',
    'legal-horizon-scan',
    'notifications-cron',
    'receipt-sync-dispatch',
    'xero-pull-bank-transactions',
    'xero-sync-accounts',
    'xero-sync-payments',
  ];

  it('no secret read from the environment is compared with === or !==', () => {
    const secretEnv = /(SECRET|KEY|TOKEN|PASSWORD)/i;
    const offenders: string[] = [];
    for (const file of sources) {
      const src = read(file);
      const ids = new Set<string>();
      for (const m of src.matchAll(
        /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:requireEnv|Deno\.env\.get)\(\s*['"]([^'"]+)['"]/g,
      )) {
        if (m[1] && m[2] && secretEnv.test(m[2])) ids.add(m[1]);
      }
      src.split(/\r?\n/).forEach((line, i) => {
        if (/^\s*(\/\/|\*)/.test(line)) return;
        for (const id of ids) {
          const cmp = new RegExp(
            `(\\b${id}\\s*[!=]==(?!\\s*(undefined|null|''|""))|[!=]==\\s*${id}\\b)`,
          );
          if (cmp.test(line) && !/(undefined|null)\s*[!=]==/.test(line))
            offenders.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it('the bearer and push-token checks that used === now use the constant-time helpers', () => {
    expect(read('supabase/functions/coding-classifier/index.ts')).toMatch(
      /isExactServiceRoleBearer\(req\.headers\.get\("Authorization"\), serviceKey\)/,
    );
    expect(read('supabase/functions/coding-classifier/index.ts')).not.toMatch(
      /bearer === serviceKey/,
    );
    expect(read('supabase/functions/gmail-pubsub-push/index.ts')).toMatch(
      /!isExactSecret\(got, expectedToken\)/,
    );
  });

  it('only the shared helper reads ?secret=, and every cron receiver goes through it', () => {
    for (const file of sources.filter((f) => !f.endsWith('_shared/cronSecret.ts'))) {
      expect(read(file), file).not.toMatch(/searchParams\.get\(\s*['"]secret['"]\s*\)/);
    }
    for (const fn of cronReceivers) {
      const src = read(`supabase/functions/${fn}/index.ts`);
      expect(src, fn).toMatch(/from ['"]\.\.\/_shared\/cronSecret\.ts['"]/);
      expect(src, fn).toMatch(/presentedCronSecret\(req\)|hasCronSecret\(req, /);
    }
    const helper = read('supabase/functions/_shared/cronSecret.ts');
    expect(helper).toContain("export const CRON_SECRET_HEADER = 'X-Cron-Secret';");
    expect(helper).toContain("import { isExactSecret } from './serviceRole.ts';");
  });

  it('functions never put a cron secret in a URL when they call each other', () => {
    for (const file of sources) {
      expect(read(file), file).not.toMatch(/\?secret=\$\{/);
    }
  });

  it('the migration moves every production URL-secret job to the x-cron-secret header, in place', () => {
    const migration = read('supabase/migrations/20261003160000_cron_secrets_in_headers.sql');
    for (const job of [
      'notifications-cron-nightly',
      'accountant-digest-cron',
      'auto-reconcile-daily',
      'bank-txn-classifier-cron',
      'automation-worker-every-2min',
      'automation-watchdog-every-15min',
      'gmail-watch-renew-daily',
      'accountant-orchestrator-daily',
      'legal-horizon-scan-3h',
      'legal-corpus-sync-daily',
      'advisor-scheduled-daily',
      'bank-sync-all',
    ]) {
      expect(migration, job).toContain(`'${job}'`);
    }
    expect(migration).toContain('cron.alter_job(job.jobid, command := rewritten)');
    expect(migration).toContain("''x-cron-secret''");
    // Behaviour (rewrite, schedule and active kept, odd shapes left alone) is tested in Postgres:
    // tests/db-sql/cron-secrets-in-headers.sql
  });

  it('no later migration schedules a job with a secret in its URL again', () => {
    const later = readdirSync('supabase/migrations')
      .filter((f) => f.endsWith('.sql') && f > '20261003160000')
      .filter((f) => f !== '20261003160000_cron_secrets_in_headers.sql');
    for (const file of later) {
      const active = read(`supabase/migrations/${file}`).replace(/--[^\n]*/g, '');
      if (/cron\.(schedule|alter_job)\s*\(/.test(active))
        expect(active, file).not.toMatch(/\?secret=/);
    }
  });
});

describe('server errors reach the client as a generic message', () => {
  it('the shared wrapper redacts every 5xx body and turns a throw into a generic 500', () => {
    const cors = read('supabase/functions/_shared/cors.ts');
    expect(cors).toContain("import { redactServerError, serverError } from './errors.ts';");
    expect(cors).toContain('res = serverError(err, req, corsHeaders);');
    expect(cors).toContain('return withCors(req, await redactServerError(req, res));');
    const errors = read('supabase/functions/_shared/errors.ts');
    expect(errors).toMatch(/if \(res\.status < 500 \|\| res\.status > 599\) return res;/);
    expect(errors).toMatch(
      /JSON\.stringify\(\{ ok: false, error: GENERIC_SERVER_ERROR, request_id: reference \}\)/,
    );
    // Behaviour, over HTTP through Deno.serve: supabase/functions/_shared/cors.test.ts and errors.test.ts.
  });

  it('every function that serves HTTP is behind that wrapper', () => {
    const entrypoints = filesUnder('supabase/functions', /^index\.ts$/).filter(
      (f) => !f.includes('/_shared/') && /\bDeno\.serve\(/.test(read(f)),
    );
    for (const file of entrypoints) {
      expect(read(file), file).toMatch(/from ['"]\.\.\/_shared\/cors\.ts['"]/);
    }
  });
});
