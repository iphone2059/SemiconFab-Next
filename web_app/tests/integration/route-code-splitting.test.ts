// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const webAppRoot = fileURLToPath(new URL('../../', import.meta.url));
const routeSource = readFileSync(new URL('../../src/routes/fab-3d.route.tsx', import.meta.url), 'utf8');
const viteConfig = readFileSync(new URL('../../vite.config.ts', import.meta.url), 'utf8');

it('A15: the 3D route declares the Twin page as a dynamic route-boundary split', () => {
  expect(routeSource).not.toMatch(/from\s+['"][^'"]*twin\/twin-page['"]/);
  expect(routeSource).toMatch(/lazy\(/);
  expect(routeSource).toMatch(/import\(\s*['"]@\/twin\/twin-page['"]\s*\)/);
  expect(routeSource).toMatch(/<Suspense\b/);
  expect(routeSource).toMatch(/fallback=/);
  expect(routeSource).toMatch(/loader:/);
});

it('A15: the frozen ARCH G-01 Vite server/build parameters are unchanged and no file-router plugin remains', () => {
  expect(viteConfig).toContain("if (id.includes('@babylonjs')) return 'gpu';");
  expect(viteConfig).toContain("server: { port: 5173, strictPort: true, host: '127.0.0.1'");
  expect(viteConfig).not.toContain('@tanstack/router-plugin');
  expect(viteConfig).not.toContain('autoCodeSplitting');
});

it('A15: the production build emits a separate Twin page chunk for the 3D route', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'sfn-twin-chunk-'));
  try {
    execFileSync(process.execPath, [join(webAppRoot, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--outDir', outDir, '--emptyOutDir', '--logLevel', 'error'], {
      cwd: webAppRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 180_000,
    });
    const assets = readdirSync(join(outDir, 'assets'));
    expect(assets.some((file) => /^twin-page-.*\.js$/.test(file)), 'expected a dedicated twin-page chunk: ' + assets.join(', ')).toBe(true);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}, 240_000);
