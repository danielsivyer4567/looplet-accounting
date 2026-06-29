import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 4000,
    strictPort: true,
  },
  build: {
    sourcemap: false,
    target: 'es2022',
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: 'react-vendor',
              test: /node_modules[\\/](react|react-dom|react-router-dom)[\\/]/,
              priority: 40,
            },
            {
              name: 'supabase-vendor',
              test: /node_modules[\\/](@supabase|@gotrue|@postgrest|@realtime|@storage-js)[\\/]/,
              priority: 30,
            },
            {
              name: 'ui-vendor',
              test: /node_modules[\\/](lucide-react|@radix-ui)[\\/]/,
              priority: 20,
            },
            {
              name: 'pdf-vendor',
              test: /node_modules[\\/]pdfjs-dist[\\/]/,
              priority: 10,
            },
            {
              name: 'vendor',
              test: /node_modules[\\/]/,
              priority: 0,
            },
          ],
        },
      },
    },
  },
});
