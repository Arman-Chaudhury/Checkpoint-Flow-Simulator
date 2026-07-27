/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    // The recharts vendor chunk is ~525 kB minified (150 kB gzipped); that is
    // the library's size, not app bloat, so the default 500 kB warning is noise.
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        // Keep the charting library in its own cacheable chunk so the app
        // chunk stays small.
        manualChunks: { recharts: ['recharts'] },
      },
    },
  },
  test: {
    // Engine tests are pure TypeScript with no DOM dependency.
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
