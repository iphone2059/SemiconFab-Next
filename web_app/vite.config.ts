import { fileURLToPath } from 'node:url';
import { loadEnv, type Plugin, type ProxyOptions } from 'vite';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * CORE-011: the same tree is built twice for the compiler equivalence harness —
 * compiler ON (release default) and OFF (control). The switch is build-time only
 * and never reaches product code; MOCK/CI must not silently turn it off.
 */
const compilerEnabled = process.env.FAB_REACT_COMPILER !== 'off';

/**
 * CORE-011 artifact marker: the production bundle itself records which compiler
 * mode built it, so the equivalence harness can prove it really compared an ON
 * build against an OFF control (a config string alone is not evidence).
 */
const compilerMarkerPlugin = (): Plugin => ({
  name: 'fab-compiler-marker',
  apply: 'build',
  generateBundle(_options, bundle) {
    const marker = compilerEnabled ? '/* FAB_COMPILER=on */' : '/* FAB_COMPILER=off */';
    for (const output of Object.values(bundle)) {
      if (output.type === 'chunk') output.code = marker + '\n' + output.code;
    }
  },
});

const apiProxy = (target: string, key: string | undefined): Record<string, ProxyOptions> => ({
  '/api': {
    target,
    changeOrigin: true,
    configure(proxy) {
      proxy.on('proxyReq', request => { request.removeHeader('X-Fab-Dev-Key'); if (key) request.setHeader('X-Fab-Dev-Key', key); });
    },
  },
});

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'FAB_');
  const key = process.env.FAB_DEVELOPMENT_KEY ?? env.FAB_DEVELOPMENT_KEY;
  const target = process.env.FAB_API_TARGET ?? env.FAB_API_TARGET ?? 'http://localhost:5080';
  const url = new URL(target);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !['http:', 'https:'].includes(url.protocol)) throw new Error('开发代理仅允许本机 API');
  const proxy = apiProxy(target, key);
  return {
    plugins: [react(compilerEnabled ? { compiler: { target: '19', compilationMode: 'infer', reportDiagnostics: true } } : {}), compilerMarkerPlugin()],
    resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
    server: { port: 5173, strictPort: true, host: '127.0.0.1', proxy },
    // The production browser gate (tools/e2e_production.mjs) drives `vite preview`,
    // so preview must reach the same local API as dev (same target validation/key).
    preview: { port: 4173, strictPort: true, host: '127.0.0.1', proxy },
    build: { rolldownOptions: { output: { manualChunks(id) { if (id.includes('@babylonjs')) return 'gpu'; if (id.includes('react')) return 'react'; } } } },
    // CPU-heavy golden-vector suites (lite-motion, tour HUD) legitimately run past
    // the 5s default when Vitest spawns 90 isolated workers on Windows. Raise only
    // the timeout budget; every assertion keeps its original strength.
    test: { testTimeout: 15000 },
  };
});
