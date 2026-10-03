#!/usr/bin/env node
// Runs SQL test files against a disposable Supabase Postgres (Docker) with every migration applied.
//
//   node scripts/db/run-pg-sql-tests.mjs tests/db-sql/a.sql [tests/db-sql/b.sql ...]
//   node scripts/db/run-pg-sql-tests.mjs --strict            # migrations only; every one must apply
//
// Each migration runs in its own transaction as the `postgres` role, like `supabase db push`. Migrations listed in
// known-migration-failures.json may fail; any other failure, or a listed migration that now applies, fails the run.
// Test files run as `postgres` with ON_ERROR_STOP, so a failed assertion (RAISE EXCEPTION) fails the run. Tests
// impersonate users with SET ROLE authenticated and request.jwt.claims. The container is always removed.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const IMAGE = process.env.LOOPLET_PG_IMAGE ?? 'public.ecr.aws/supabase/postgres:17.6.1.063';
const args = process.argv.slice(2);
const strict = args.includes('--strict');
const tests = args.filter((a) => !a.startsWith('--'));
if (!strict && tests.length === 0) {
  console.error('usage: run-pg-sql-tests.mjs <test.sql>... | --strict');
  process.exit(2);
}
for (const t of tests) if (!existsSync(join(ROOT, t))) { console.error(`missing test file: ${t}`); process.exit(1); }

const name = `looplet-sqltest-${process.pid}-${randomBytes(3).toString('hex')}`;
const password = randomBytes(18).toString('hex');

function docker(argv, input) {
  return spawnSync('docker', argv, { input, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}
function psql(sql, { user = 'postgres', singleTransaction = false } = {}) {
  const argv = ['exec', '-i', '-e', `PGPASSWORD=${password}`, name, 'psql', '-h', 'localhost', '-U', user, '-d', 'postgres',
    '-v', 'ON_ERROR_STOP=1', '-X', '-q', ...(singleTransaction ? ['--single-transaction'] : []), '-f', '-'];
  const r = docker(argv, sql);
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}
function cleanup() { docker(['rm', '-f', name]); }

let exitCode = 1;
try {
  const run = docker(['run', '-d', '--name', name, '-e', `POSTGRES_PASSWORD=${password}`, IMAGE]);
  if (run.status !== 0) throw new Error(`could not start ${IMAGE}: ${run.stderr}`);
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    ready = docker(['exec', name, 'pg_isready', '-h', 'localhost', '-U', 'postgres']).status === 0 && psql('select 1;').ok;
    if (!ready) spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},1000)']);
  }
  if (!ready) throw new Error('database did not become ready');

  const stub = psql(readFileSync(join(ROOT, 'scripts/db/supabase-storage-stub.sql'), 'utf8'), { user: 'supabase_admin' });
  if (!stub.ok) throw new Error(`storage stub failed:\n${stub.out}`);

  const known = strict ? {} : JSON.parse(readFileSync(join(ROOT, 'scripts/db/known-migration-failures.json'), 'utf8')).failures;
  const migrationsDir = join(ROOT, 'supabase/migrations');
  const migrations = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  const problems = [];
  let applied = 0;
  let expectedFailures = 0;
  for (const file of migrations) {
    const r = psql(readFileSync(join(migrationsDir, file), 'utf8'), { singleTransaction: true });
    if (r.ok && known[file]) problems.push(`${file} now applies; remove it from known-migration-failures.json`);
    else if (r.ok) applied++;
    else if (known[file]) expectedFailures++;
    else problems.push(`${file} failed:\n${r.out.split('\n').filter((l) => /ERROR|DETAIL|HINT/.test(l)).slice(0, 4).join('\n')}`);
  }
  for (const file of Object.keys(known)) if (!migrations.includes(file)) problems.push(`${file} is listed as a known failure but does not exist`);
  console.log(`migrations: ${applied} applied, ${expectedFailures} known failures, ${problems.length} problems (${migrations.length} files)`);
  if (problems.length) throw new Error(`migration problems:\n- ${problems.join('\n- ')}`);

  let failed = 0;
  for (const test of tests) {
    const r = psql(readFileSync(join(ROOT, test), 'utf8'));
    // On failure show everything psql printed (multi-line assertion messages included); on success just the notices.
    const lines = r.out.split('\n').filter((l) => l.trim() && (!r.ok ? true : /NOTICE/.test(l)));
    const notices = lines.slice(0, 400).map((l) => `  ${l.replace(/^psql:<stdin>:\d+: /, '')}`).join('\n');
    console.log(`${r.ok ? 'PASS' : 'FAIL'} ${relative(ROOT, join(ROOT, test)).replace(/\\/g, '/')}${notices ? `\n${notices}` : ''}`);
    if (!r.ok) failed++;
  }
  exitCode = failed ? 1 : 0;
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  exitCode = 1;
} finally {
  cleanup();
}
process.exit(exitCode);
