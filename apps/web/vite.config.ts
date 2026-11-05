import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// @penny/shared's index pulls node:crypto; the browser only needs its RFC 8785 canonicalizer.
const canonical = fileURLToPath(new URL('../../packages/shared/src/canonical.ts', import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@penny/shared/canonical': canonical } },
  define: {
    // `MOCK=1 bun run dev` turns on the in-app scripted engine.
    'import.meta.env.VITE_MOCK': JSON.stringify(process.env.MOCK ?? process.env.VITE_MOCK ?? ''),
  },
  server: { port: 5174 },
});
