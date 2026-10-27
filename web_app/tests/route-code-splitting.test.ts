import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const routeSource = readFileSync(
  new URL('../src/app/router/routes/fabs/$fabId/3d.tsx', import.meta.url),
  'utf8',
);
const viteConfig = readFileSync(new URL('../vite.config.ts', import.meta.url), 'utf8');

it('A15: the 3D route splits the Twin page at the route boundary instead of static-importing it', () => {
  // ARCH G-01 keeps the Vite server/build parameters frozen, so the split is
  // code-based: the route must lazy-import the page graph and render a Suspense
  // fallback, while the loader keeps its synchronous query boundary.
  expect(routeSource).not.toMatch(/from\s+['"][^'"]*features\/twin\/twin-page['"]/);
  expect(routeSource).toMatch(/lazy\(/);
  expect(routeSource).toMatch(/import\(\s*['"][^'"]*features\/twin\/twin-page['"]\s*\)/);
  expect(routeSource).toMatch(/<Suspense\b/);
  expect(routeSource).toMatch(/fallback=/);
  expect(routeSource).toMatch(/loader:/);
});

it('A15: the frozen ARCH G-01 Vite server/build parameters are unchanged', () => {
  expect(viteConfig).toContain('autoCodeSplitting: false');
  expect(viteConfig).toContain("if (id.includes('@babylonjs')) return 'gpu';");
  expect(viteConfig).toContain('server: { port: 5173, strictPort: true, host: \'127.0.0.1\'');
  expect(viteConfig).toContain('Route-code generation only');
});
