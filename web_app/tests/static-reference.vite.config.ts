import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
export default defineConfig({
  ssr: { noExternal: true },
  build: {
    ssr: fileURLToPath(new URL('./static-reference.capture.ts', import.meta.url)),
    outDir: '../.local/lite-static-capture-bin', emptyOutDir: true,
    rolldownOptions: { output: { entryFileNames: 'capture.mjs', chunkFileNames: 'assets/[name]-[hash].mjs' } },
  },
});
