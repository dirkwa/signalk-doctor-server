import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));

const pkgVersion = (
  JSON.parse(readFileSync(resolve(here, 'package.json'), 'utf-8')) as { version: string }
).version;

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(pkgVersion) },
  base: '/',
  root: resolve(here, 'webapp'),
  build: {
    outDir: resolve(here, 'webapp-dist'),
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022',
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.DOCTOR_DEV_URL ?? 'http://127.0.0.1:3004',
        changeOrigin: true,
        ws: false,
      },
    },
  },
});
