import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('./lite-effects-color', import.meta.url)),
  cacheDir: '../../../.local/lite-effects-color-cache',
  server: { host: '127.0.0.1', port: 5182, strictPort: true,
    fs: { allow: [fileURLToPath(new URL('..', import.meta.url))] } },
  build: { outDir: '../../../.local/lite-effects-color-dist', emptyOutDir: true },
});
