import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Served by the same Express app under /viewer (T7): base and outDir are the
// two halves of that contract — app.ts statically serves <repo>/dist/viewer.
export default defineConfig({
  plugins: [react()],
  base: '/viewer/',
  build: {
    outDir: '../dist/viewer',
    emptyOutDir: true,
  },
  server: {
    // Dev nicety: `npm run dev:viewer` against a locally running server.
    proxy: { '/audit': 'http://localhost:3000' },
  },
});
