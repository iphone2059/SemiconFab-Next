// Separate test server and bundle: the production entry cannot reach this scene.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('./lite-runtime', import.meta.url)),
  cacheDir: '../../../.local/lite-runtime-vite-cache',
  server: {
    host: '127.0.0.1', port: 5175, strictPort: true,
    fs: { allow: [fileURLToPath(new URL('..', import.meta.url))] },
  },
  build: { outDir: '../../../.local/lite-runtime-dist', emptyOutDir: true },
});
