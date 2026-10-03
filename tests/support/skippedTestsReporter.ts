import { appendFileSync } from 'node:fs';
import type { Reporter, TestModule } from 'vitest/node';

// CI-01. Most live suites skip themselves when the Supabase secrets are absent (`it.skipIf(!HAS_ENV)`),
// which on a pull request is every run. Vitest counts those as "skipped" and the job stays green, so a
// suite that checked nothing looked the same as one that passed. vitest.config.ts adds this reporter in
// GitHub Actions: it prints every test file that skipped tests, raises one warning annotation with the
// totals (GitHub shows only ten annotations per step, so the file list goes in the log and the job
// summary), and writes a table to the job summary.

export interface SkippedFile {
  file: string;
  skipped: number;
  total: number;
}

type ModuleLike = Pick<TestModule, 'relativeModuleId' | 'children'>;

/** Files with at least one skipped test, files that skipped everything first. */
export function skippedFiles(modules: readonly ModuleLike[]): SkippedFile[] {
  const out: SkippedFile[] = [];
  for (const module of modules) {
    let skipped = 0;
    let total = 0;
    for (const test of module.children.allTests()) {
      total += 1;
      if (test.result().state === 'skipped') skipped += 1;
    }
    if (skipped > 0)
      out.push({ file: module.relativeModuleId.replace(/\\/g, '/'), skipped, total });
  }
  const whole = (f: SkippedFile) => (f.skipped === f.total ? 0 : 1);
  return out.sort((a, b) => whole(a) - whole(b) || a.file.localeCompare(b.file));
}

// Workflow-command escaping: https://docs.github.com/actions/reference/workflow-commands-for-github-actions
const escapeData = (s: string) =>
  s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

export function formatSkipReport(files: readonly SkippedFile[]): { log: string; summary: string } {
  const whole = files.filter((f) => f.skipped === f.total);
  const tests = files.reduce((n, f) => n + f.skipped, 0);
  const headline =
    `${files.length} test file(s) skipped ${tests} test(s); ${whole.length} file(s) skipped every test and checked nothing in this run. ` +
    'Most are live suites that need Supabase secrets.';
  const rows = files.map(
    (f) => `${f.skipped === f.total ? 'ALL ' : '    '} ${f.skipped}/${f.total}  ${f.file}`,
  );
  const log = [
    `::warning title=Skipped tests::${escapeData(headline)}`,
    'Skipped tests by file (ALL = every test in the file skipped):',
    ...rows,
    '',
  ].join('\n');
  const summary = [
    '### Skipped tests',
    '',
    headline,
    '',
    '| File | Skipped | Tests | Ran nothing |',
    '| --- | ---: | ---: | :---: |',
    ...files.map(
      (f) =>
        `| \`${f.file}\` | ${f.skipped} | ${f.total} | ${f.skipped === f.total ? 'yes' : ''} |`,
    ),
    '',
  ].join('\n');
  return { log, summary };
}

export default class SkippedTestsReporter implements Reporter {
  onTestRunEnd(testModules: readonly TestModule[]): void {
    const files = skippedFiles(testModules);
    if (files.length === 0) return;
    const { log, summary } = formatSkipReport(files);
    process.stdout.write(`\n${log}`);
    const summaryFile = process.env['GITHUB_STEP_SUMMARY'];
    if (summaryFile) appendFileSync(summaryFile, `${summary}\n`);
  }
}
