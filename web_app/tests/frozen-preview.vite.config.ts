// Test-only production preview. The application build never imports this configuration.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type PreviewServer } from 'vite';
import configuration from '../vite.config.ts';
// @ts-expect-error Node-only test tooling has no declaration file.
import { GOLDEN_CLOCK } from '../../tools/frozen_visual_compare.mjs';

export default defineConfig(async environment => {
  const base = typeof configuration === 'function' ? await configuration(environment) : configuration;
  const outDir = resolve(process.env.FAB_FROZEN_DIST ?? 'dist');
  return {
    ...base,
    build: { ...base.build, outDir },
    plugins: [...(base.plugins ?? []), {
      name: 'frozen-clock-preview',
      configurePreviewServer(server: PreviewServer) {
        server.middlewares.use((request, response, next) => {
          const url = new URL(request.url ?? '/', 'http://127.0.0.1');
          if (!['/', '/twin', '/twin.html'].includes(url.pathname) || url.searchParams.get('parity') !== '1') return next();
          response.setHeader('Content-Type', 'text/html; charset=utf-8');
          response.setHeader('Cache-Control', 'no-store');
          response.end(readFileSync(resolve(outDir, 'index.html'), 'utf8')
            .replace('<head>', `<head><script data-parity-input="seed-and-clock">${GOLDEN_CLOCK}</script>`));
        });
      },
    }],
  };
});
