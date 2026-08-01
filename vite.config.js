import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// The Base44 plugin used to sit ahead of react() here, supplying legacy `@/…`
// SDK aliases plus an HMR/analytics/visual-edit agent for the Base44 IDE. All
// of that served a backend this project no longer has. The one thing it also
// quietly provided was the `@` path alias that the entire codebase imports
// through — so that is declared explicitly here rather than inherited from a
// plugin nobody realised was load-bearing.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'src'),
    },
  },
});
