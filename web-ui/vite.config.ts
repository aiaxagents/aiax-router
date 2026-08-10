import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Relative base, because the same build is served from a laptop, a phone on the
 * tailnet and the desktop app. Nothing in the page may assume it lives at "/".
 */
export default defineConfig({
  plugins: [react()],
  base: './',
  build: { outDir: '../dist-web', emptyOutDir: true },
  server: {
    proxy: {
      '/api': { target: 'http://127.0.0.1:4300', changeOrigin: false },
      '/results': { target: 'http://127.0.0.1:4300', changeOrigin: false },
    },
  },
});
