import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// In GitHub Actions, also list every test file that skipped tests (mostly live suites gated on
// Supabase secrets) in the log, as a warning and in the job summary, so a gated suite never passes
// silently. Locally the default reporter is unchanged.
const ciReporters =
  process.env['GITHUB_ACTIONS'] === 'true'
    ? { reporters: ['default', 'github-actions', './tests/support/skippedTestsReporter.ts'] }
    : {};

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    exclude: ['node_modules', 'dist'],
    testTimeout: 30000,
    ...ciReporters,

    /**
     * Each project sets its own environment. (Vitest 4 ignores the old `environmentMatchGlobs`
     * option, so tests/ used to run in jsdom as well.)
     *
     * - unit: React component and library tests in src/ run in jsdom without per-file annotations.
     * - integration: tests/ runs in Node. These read the repo and hit real Supabase when configured,
     *   and must not have jsdom globals in scope.
     */
    projects: [
      {
        extends: true,
        test: { name: 'unit', environment: 'jsdom', include: ['src/**/*.test.{ts,tsx}'] },
      },
      {
        extends: true,
        test: { name: 'integration', environment: 'node', include: ['tests/**/*.test.ts'] },
      },
    ],

    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/test/**', 'src/vite-env.d.ts', 'src/main.tsx', 'src/lib/database.types.ts'],
    },
  },
});
