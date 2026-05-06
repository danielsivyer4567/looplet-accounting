import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    /**
     * Default environment is jsdom so React component tests in src/test/ work
     * without per-file annotations.
     *
     * tests/ (integration) runs in Node — controlled via environmentMatchGlobs
     * so the existing tenant-isolation.test.ts does not need modification.
     */
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['tests/**/*.test.ts', 'src/**/*.test.{ts,tsx}'],
    exclude: ['node_modules', 'dist'],
    testTimeout: 30000,

    environmentMatchGlobs: [
      // Integration tests (tests/ directory) run in Node — they hit real
      // Supabase and must not have jsdom globals in scope.
      ['tests/**', 'node'],
    ],

    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/test/**',
        'src/vite-env.d.ts',
        'src/main.tsx',
        'src/lib/database.types.ts',
      ],
    },
  },
});
