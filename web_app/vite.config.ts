import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { tanstackRouter } from '@tanstack/router-plugin/vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'FAB_');
  const key = process.env.FAB_DEVELOPMENT_KEY ?? env.FAB_DEVELOPMENT_KEY;
  const target = process.env.FAB_API_TARGET ?? env.FAB_API_TARGET ?? 'http://localhost:5080';
  const url = new URL(target);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !['http:', 'https:'].includes(url.protocol)) throw new Error('开发代理仅允许本机 API');
  return {
    plugins: [
      // Route-code generation only. server/build parameters below remain frozen (ARCH G-01).
      tanstackRouter({
        target: 'react',
        autoCodeSplitting: false,
        routesDirectory: './src/app/router/routes',
        generatedRouteTree: './src/app/router/routeTree.gen.ts',
      }),
      react(),
    ],
    server: { port: 5173, strictPort: true, host: '127.0.0.1', proxy: { '/api': { target, changeOrigin: true, configure(proxy) {
      proxy.on('proxyReq', request => { request.removeHeader('X-Fab-Dev-Key'); if (key) request.setHeader('X-Fab-Dev-Key', key); });
    } } } },
    build: { rolldownOptions: { output: { manualChunks(id) { if (id.includes('@babylonjs')) return 'gpu'; if (id.includes('react')) return 'react'; } } } },
    // CPU-heavy golden-vector suites (lite-motion, tour HUD) legitimately run past
    // the 5s default when Vitest spawns 90 isolated workers on Windows. Raise only
    // the timeout budget; every assertion keeps its original strength.
    test: { testTimeout: 15000 },
  };
});
