/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the site runs on Vite (http://localhost:5173) and API calls go through
// Vite's proxy to the Node API, so the browser sees one origin, exactly like production
// behind Nginx. Same origin means no CORS, and the session cookie just works.
const API = process.env.VITE_API_PROXY ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: API, changeOrigin: false },
      '/health': API,
      '/ready': API,
    },
  },
  build: {
    // No public source maps: they'd publish the original source. In production you upload
    // them to an error tracker (Sentry etc.) instead of serving them.
    sourcemap: false,
    // Hashed file names (app-3f9c1a.js): safe to cache forever at the edge.
    assetsDir: 'assets',
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    restoreMocks: true,
  },
});
