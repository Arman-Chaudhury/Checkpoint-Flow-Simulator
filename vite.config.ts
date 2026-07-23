/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    // Engine tests are pure TypeScript with no DOM dependency.
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
