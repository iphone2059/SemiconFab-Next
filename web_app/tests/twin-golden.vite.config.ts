// Capture server only. Never selected by the normal dev/build configuration.
import { defineConfig, type ConfigEnv, type IndexHtmlTransformContext } from 'vite';
import configuration from '../vite.config.ts';
import { GOLDEN_CLOCK } from './twin-goldens.browser.ts';

export default defineConfig(async (environment: ConfigEnv) => {
  const base = typeof configuration === 'function' ? await configuration(environment) : await configuration;
  return {
    ...base,
    cacheDir: '../.local/twin-golden-repro-vite-cache',
    plugins: [...(base.plugins ?? []), {
      name: 'declared-twin-golden-inputs',
      transformIndexHtml: {
        order: 'pre',
        handler(html: string, context: IndexHtmlTransformContext) {
          return new URL(context.originalUrl ?? '/', 'http://localhost').searchParams.get('parity') === '1'
            ? html.replace('<head>', `<head><script data-parity-input="seed-and-clock">${GOLDEN_CLOCK}</script>`)
            : html;
        },
      },
    }],
  };
});
