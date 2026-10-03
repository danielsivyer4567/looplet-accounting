import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SkippedTestsReporter, {
  formatSkipReport,
  skippedFiles,
} from '../support/skippedTestsReporter';
import { asMap, jobsOf, loadWorkflows, must, stepsOf } from './workflowYaml';

// CI-01. CI must run the Deno edge-function tests, run tests/ in Node (Vitest 4 ignores the old
// environmentMatchGlobs option), and say which test files skipped instead of passing them silently.

interface ProjectLike {
  test?: { name?: string; environment?: string; include?: string[] };
}

async function loadConfig(env: Record<string, string>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const mod = (await import('../../vitest.config')) as {
    default: { test?: Record<string, unknown> };
  };
  return must(mod.default.test, 'vitest test config');
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('tests/ runs in Node (CI-01)', () => {
  it('has no jsdom globals in this file', () => {
    // Under the old config every tests/ file silently ran in jsdom.
    expect(typeof window).toBe('undefined');
    expect(typeof document).toBe('undefined');
  });

  it('declares one jsdom project for src/ and one Node project for tests/', async () => {
    const config = await loadConfig({ GITHUB_ACTIONS: '' });
    expect(config['environmentMatchGlobs']).toBeUndefined();
    expect(readFileSync('vitest.config.ts', 'utf8')).not.toMatch(/environmentMatchGlobs\s*:/);
    const projects = (config['projects'] as ProjectLike[]).map((p) => p.test);
    expect(projects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'unit',
          environment: 'jsdom',
          include: ['src/**/*.test.{ts,tsx}'],
        }),
        expect.objectContaining({
          name: 'integration',
          environment: 'node',
          include: ['tests/**/*.test.ts'],
        }),
      ]),
    );
  });
});

describe('skipped test files are reported in CI (CI-01)', () => {
  const fakeModule = (file: string, states: string[]) => ({
    relativeModuleId: file,
    children: {
      *allTests() {
        for (const state of states) yield { result: () => ({ state }) };
      },
    },
  });
  const modules = [
    fakeModule('tests/payroll-termination.test.ts', ['skipped']),
    fakeModule('tests/automation-watchdog.test.ts', ['passed', 'skipped', 'skipped']),
    fakeModule('tests/ok.test.ts', ['passed', 'passed']),
    fakeModule('tests\\accruals-run.test.ts', ['skipped', 'skipped']),
  ] as unknown as Parameters<typeof skippedFiles>[0];

  it('lists files that skipped tests, files that ran nothing first, and leaves passing files out', () => {
    expect(skippedFiles(modules)).toEqual([
      { file: 'tests/accruals-run.test.ts', skipped: 2, total: 2 },
      { file: 'tests/payroll-termination.test.ts', skipped: 1, total: 1 },
      { file: 'tests/automation-watchdog.test.ts', skipped: 2, total: 3 },
    ]);
  });

  it('prints one warning with the totals, every file in the log, and a job-summary table', () => {
    const { log, summary } = formatSkipReport(skippedFiles(modules));
    const lines = log.split('\n');
    expect(lines.filter((l) => l.startsWith('::'))).toEqual([
      '::warning title=Skipped tests::3 test file(s) skipped 5 test(s); 2 file(s) skipped every test and checked nothing in this run. Most are live suites that need Supabase secrets.',
    ]);
    expect(lines).toEqual(
      expect.arrayContaining([
        'ALL  2/2  tests/accruals-run.test.ts',
        'ALL  1/1  tests/payroll-termination.test.ts',
        '     2/3  tests/automation-watchdog.test.ts',
      ]),
    );
    expect(summary).toContain('| `tests/accruals-run.test.ts` | 2 | 2 | yes |');
    expect(summary).toContain('| `tests/automation-watchdog.test.ts` | 2 | 3 |  |');
  });

  it('writes to the log and the GitHub job summary at the end of the run, and stays quiet when nothing skipped', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skip-report-'));
    const summaryFile = join(dir, 'summary.md');
    vi.stubEnv('GITHUB_STEP_SUMMARY', summaryFile);
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const reporter = new SkippedTestsReporter();
      reporter.onTestRunEnd([modules[2]] as never);
      expect(write).not.toHaveBeenCalled();
      expect(existsSync(summaryFile)).toBe(false);

      reporter.onTestRunEnd(modules as never);
      expect(String(write.mock.calls[0]?.[0])).toContain(
        '::warning title=Skipped tests::3 test file(s)',
      );
      expect(readFileSync(summaryFile, 'utf8')).toContain('### Skipped tests');
    } finally {
      write.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is switched on in GitHub Actions only, next to the default and GitHub reporters', async () => {
    expect(existsSync('tests/support/skippedTestsReporter.ts')).toBe(true);
    expect((await loadConfig({ GITHUB_ACTIONS: 'true' }))['reporters']).toEqual([
      'default',
      'github-actions',
      './tests/support/skippedTestsReporter.ts',
    ]);
    expect((await loadConfig({ GITHUB_ACTIONS: '' }))['reporters']).toBeUndefined();
  });
});

describe('CI runs the Deno edge-function tests (CI-01)', () => {
  const ci = must(
    loadWorkflows().find((w) => w.file.endsWith('/ci.yml')),
    'ci.yml',
  );
  const jobs = new Map(jobsOf(ci));

  it('has a job that installs Deno and runs every test under supabase/functions', () => {
    const job = must(jobs.get('edge-functions'), 'edge-functions job');
    const steps = stepsOf(job, 'edge-functions');
    expect(steps.some((s) => String(s['uses'] ?? '').startsWith('denoland/setup-deno@'))).toBe(
      true,
    );
    const test = must(
      steps.find((s) => String(s['run'] ?? '').startsWith('deno test')),
      'deno test step',
    );
    const run = String(test['run']);
    for (const flag of ['--allow-env', '--allow-read', '--allow-net']) expect(run).toContain(flag);
    expect(run).toMatch(/ supabase\/functions$/);
    expect(run).not.toMatch(/--allow-all|-A\b|--allow-run|--allow-write/);
    // No secrets: these are unit tests of the functions' logic.
    expect(JSON.stringify(job)).not.toContain('secrets.');
  });

  it('runs the Deno job on every push and pull request with read-only permissions', () => {
    // There is no deploy job any more (CI-02): Cloudflare Pages deploys main itself, so the Deno job guards the
    // pull request check rather than a deploy step.
    expect(jobs.has('deploy')).toBe(false);
    const edge = must(jobs.get('edge-functions'), 'edge-functions job');
    expect(edge['if']).toBeUndefined();
    expect(asMap(edge['permissions'], 'permissions')).toEqual({ contents: 'read' });
  });
});
