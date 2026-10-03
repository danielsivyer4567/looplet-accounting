import { describe, expect, it } from 'vitest';
import {
  asMap,
  jobsOf,
  loadWorkflows,
  must,
  parseWorkflowYaml,
  stepsOf,
  type Workflow,
  type YamlMap,
  type YamlValue,
} from './workflowYaml';

// SEC-06. In August 2026 an implant in this repo's build config ran on every CI build while the
// Cloudflare and Supabase secrets were in the same job. These checks read every workflow file and
// hold the line on: least-privilege token permissions, actions pinned to full commit SHAs, and deploy
// secrets kept out of any job that installs, builds or tests the app.

const workflows = loadWorkflows();
const byName = (name: string): Workflow => {
  const found = workflows.find((w) => w.file.endsWith(`/${name}`));
  if (!found) throw new Error(`missing workflow ${name}`);
  return found;
};

// Secrets that can publish the app or change the production database. Only deploy jobs may hold them.
const DEPLOY_SECRETS = [
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID',
  'SUPABASE_ACCESS_TOKEN',
  'SUPABASE_DB_PASSWORD',
];
// Commands that run repository code beyond a pinned CLI: build configs, tests, linters.
const RUNS_APP_CODE =
  /\bnpm (run|test)\b|\bvitest\b|\bvite\b|\btsc\b|\beslint\b|\bprettier\b|\bnpx (vite|vitest|tsc|eslint|prettier)\b/;
// Per-job write scopes this repo has decided it needs, with the reason. Empty: no job writes.
const ALLOWED_WRITE_SCOPES: Record<string, string[]> = {};

function stepsText(job: YamlMap, what: string): string[] {
  return stepsOf(job, what).map((step) => String(step['run'] ?? ''));
}

function refsSecret(job: YamlMap, secret: string): boolean {
  return JSON.stringify(job).includes(`secrets.${secret}`);
}

describe('the workflow reader is strict', () => {
  it('reads mappings, lists, quoted and block scalars, and drops comments', () => {
    const doc = parseWorkflowYaml(
      [
        'on:',
        '  push:',
        '    branches: [main, "release"]',
        'jobs:',
        '  a:',
        '    steps:',
        '      - uses: owner/repo@abc # v1',
        '        with:',
        "          flag: 'false'",
        '      - run: |',
        '          echo "# not a comment"',
        '          npm ci',
      ].join('\n'),
    );
    expect(doc).toEqual({
      on: { push: { branches: ['main', 'release'] } },
      jobs: {
        a: {
          steps: [
            { uses: 'owner/repo@abc', with: { flag: 'false' } },
            { run: 'echo "# not a comment"\nnpm ci\n' },
          ],
        },
      },
    });
  });

  it('refuses YAML it cannot check rather than reading it loosely', () => {
    expect(() => parseWorkflowYaml('a: &anchor x\nb: *anchor')).toThrow();
    expect(() => parseWorkflowYaml('a: {b: c}')).toThrow();
    expect(() => parseWorkflowYaml('a:\n\tb: c')).toThrow();
    expect(() => parseWorkflowYaml('a: b\na: c')).toThrow(/duplicate key/);
    expect(() => parseWorkflowYaml('a: one\n  two')).toThrow(/indentation/);
  });
});

describe('CI workflows (SEC-06)', () => {
  it('finds the CI and staging workflows', () => {
    expect(workflows.map((w) => w.file)).toEqual(
      expect.arrayContaining(['.github/workflows/ci.yml', '.github/workflows/staging-deploy.yml']),
    );
  });

  for (const workflow of workflows) {
    describe(workflow.file, () => {
      it('defaults the token to read-only repository contents', () => {
        expect(workflow.doc['permissions']).toEqual({ contents: 'read' });
      });

      it('never widens a job beyond read access unless the scope is allow-listed with a reason', () => {
        for (const [id, job] of jobsOf(workflow)) {
          const perms = job['permissions'];
          expect(perms, `${id} must state its permissions`).toBeDefined();
          expect(perms).not.toBe('write-all');
          expect(perms).not.toBe('read-all');
          for (const [scope, level] of Object.entries(asMap(perms, `${id} permissions`))) {
            if (level === 'read' || level === 'none') continue;
            expect(
              ALLOWED_WRITE_SCOPES[id] ?? [],
              `${workflow.file} job ${id} asks for ${scope}: ${String(level)}`,
            ).toContain(scope);
          }
        }
      });

      it('is not triggered by pull_request_target or workflow_run (which run with secrets on outside code)', () => {
        const on = asMap(workflow.doc['on'], 'on');
        expect(Object.keys(on)).not.toContain('pull_request_target');
        expect(Object.keys(on)).not.toContain('workflow_run');
      });

      it('pins every action to a full commit SHA with the tag in a comment', () => {
        const uses: string[] = [];
        for (const [id, job] of jobsOf(workflow)) {
          if (typeof job['uses'] === 'string') uses.push(job['uses']);
          for (const step of stepsOf(job, id))
            if (typeof step['uses'] === 'string') uses.push(step['uses']);
        }
        expect(uses.length).toBeGreaterThan(0);
        for (const ref of uses) {
          if (ref.startsWith('./')) continue; // a local action is pinned by this commit
          expect(ref, 'docker actions must be pinned by digest').not.toMatch(
            /^docker:\/\/(?!.*@sha256:[0-9a-f]{64}$)/,
          );
          if (ref.startsWith('docker://')) continue;
          expect(ref).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
        }
        // And on the raw text, so a reader quirk cannot hide a floating tag. Same action, same tag → same SHA.
        const seen = new Map<string, string>();
        const usesLines = workflow.raw
          .split(/\r?\n/)
          .filter((line) => /^\s*(-\s+)?uses:/.test(line));
        expect(usesLines.length).toBe(uses.length);
        for (const line of usesLines) {
          if (/uses:\s*\.\//.test(line)) continue;
          const match =
            /uses:\s*([\w.-]+\/[\w./-]+)@([0-9a-f]{40})\s+#\s*(v\d+(?:\.\d+){0,2})\s*$/.exec(line);
          expect(match, `not SHA-pinned with a tag comment: ${line.trim()}`).not.toBeNull();
          const [, action, sha = '', tag] = must(match, line);
          const key = `${action}@${tag}`;
          if (seen.has(key)) expect(sha, `${key} pinned to two SHAs`).toBe(seen.get(key));
          seen.set(key, sha);
        }
      });

      it('checks out without leaving the token in .git/config', () => {
        for (const [id, job] of jobsOf(workflow)) {
          for (const step of stepsOf(job, id)) {
            if (typeof step['uses'] === 'string' && step['uses'].startsWith('actions/checkout@')) {
              expect(
                asMap(step['with'], `${id} checkout with`)['persist-credentials'],
                `${id} checkout`,
              ).toBe('false');
            }
          }
        }
      });

      it('installs without lifecycle scripts, after the build-config integrity check', () => {
        for (const [id, job] of jobsOf(workflow)) {
          const runs = stepsText(job, id);
          const install = runs.findIndex((run) => /\bnpm (ci|install|i)\b/.test(run));
          if (install < 0) continue;
          expect(runs[install], `${id} install`).toMatch(/^npm ci --ignore-scripts\s*$/);
          const integrity = runs.findIndex((run) =>
            run.includes('node scripts/check-build-config-integrity.mjs'),
          );
          expect(
            integrity,
            `${id} runs the integrity check before installing`,
          ).toBeGreaterThanOrEqual(0);
          expect(integrity).toBeLessThan(install);
        }
      });

      it('keeps deploy secrets out of every job that builds, tests or lints the app', () => {
        for (const [id, job] of jobsOf(workflow)) {
          const held = DEPLOY_SECRETS.filter((secret) => refsSecret(job, secret));
          if (held.length === 0) continue;
          for (const run of stepsText(job, id)) {
            expect(
              run,
              `${workflow.file} job ${id} holds ${held.join(', ')} and runs app code`,
            ).not.toMatch(RUNS_APP_CODE);
          }
          // A secrets job only starts after the gates, so a red gate never reaches it.
          expect(job['needs'], `${id} must wait for the gates`).toBeTruthy();
        }
      });
    });
  }
});

describe('ci.yml builds an artifact and never deploys (SEC-06, CI-02)', () => {
  const jobs = new Map(jobsOf(byName('ci.yml')));

  it('builds and uploads dist in a job without deploy secrets', () => {
    const build = must(jobs.get('build'), 'build job');
    for (const secret of DEPLOY_SECRETS) expect(refsSecret(build, secret), secret).toBe(false);
    const steps = stepsOf(build, 'build');
    const buildAt = steps.findIndex((s) => /npm run build/.test(String(s['run'] ?? '')));
    const uploadAt = steps.findIndex((s) => String(s['uses'] ?? '').startsWith('actions/upload-artifact@'));
    expect(buildAt).toBeGreaterThanOrEqual(0);
    expect(uploadAt).toBeGreaterThan(buildAt);
    expect(asMap(must(steps[uploadAt], 'upload step')['with'], 'upload with')).toMatchObject({
      name: 'dist',
      path: 'dist',
    });
  });

  it('has no deploy job: Cloudflare Pages deploys main through its Git integration', () => {
    // A second production path in CI needed a long-lived Cloudflare API token in GitHub, which the August
    // implant could read. Production is published only by merging to main.
    expect(jobs.has('deploy')).toBe(false);
    for (const [name, job] of jobs) {
      for (const secret of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID']) {
        expect(refsSecret(job, secret), `${name} references ${secret}`).toBe(false);
      }
      const steps = stepsOf(job, name);
      expect(steps.some((s) => String(s['uses'] ?? '').startsWith('cloudflare/wrangler-action@')), `${name} runs wrangler`).toBe(false);
      expect(steps.some((s) => /pages deploy/.test(String(s['run'] ?? ''))), `${name} runs pages deploy`).toBe(false);
    }
  });
});

describe('staging-deploy.yml keeps its gates and deploy steps, split by secrets (SEC-06)', () => {
  const staging = byName('staging-deploy.yml');
  const jobs = new Map(jobsOf(staging));
  const runs = (id: string): YamlValue[] =>
    stepsOf(must(jobs.get(id), id), id).map((s) => s['run'] ?? s['uses'] ?? null);

  it('runs the same gates first, with no deploy secrets and no environment', () => {
    const gates = must(jobs.get('gates'), 'gates job');
    expect(gates['environment']).toBeUndefined();
    for (const secret of DEPLOY_SECRETS) expect(refsSecret(gates, secret), secret).toBe(false);
    expect(runs('gates')).toEqual(
      expect.arrayContaining([
        'npm run format:check',
        'npm run lint',
        'npm run typecheck',
        'npm test',
        'npm run test:accounting',
        'npx vitest run src/test/db/deploymentDocsReconciliation.test.ts',
        'npm run build',
      ]),
    );
  });

  it('then runs the migration dry run and optional function deploy in the chosen environment', () => {
    const preflight = must(jobs.get('preflight'), 'preflight job');
    expect(preflight['needs']).toBe('gates');
    expect(preflight['environment']).toBe('${{ inputs.environment }}');
    const steps = stepsOf(preflight, 'preflight');
    const dryRun = must(
      steps.find((s) => s['name'] === 'Migration dry run'),
      'dry run step',
    );
    expect(String(dryRun['run'])).toContain('npx supabase db push --linked --dry-run');
    expect(asMap(dryRun['env'], 'dry run env')).toEqual({
      SUPABASE_ACCESS_TOKEN: '${{ secrets.SUPABASE_ACCESS_TOKEN }}',
      SUPABASE_DB_PASSWORD: '${{ secrets.SUPABASE_DB_PASSWORD }}',
    });
    const functions = must(
      steps.find((s) => s['name'] === 'Deploy default edge functions'),
      'functions step',
    );
    expect(functions['if']).toBe("${{ inputs.deploy_edge_functions == 'true' }}");
    expect(String(functions['run'])).toContain(
      'npx supabase functions deploy "$fn" --use-api --project-ref "$SUPABASE_PROJECT_REF"',
    );
  });
});
