// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { router } from '@/routes/router';
import { rootRoute } from '@/routes/root.route';

it('builds the canonical route tree without a generated route file', () => {
  const ids = Object.keys(router.routesById).sort();
  expect(ids).toEqual(expect.arrayContaining([
    '/',
    '/equipment',
    '/equipment/',
    '/equipment/compare',
    // R5.4-03: composite (siteId, fabId) identity; the old /fabs/$fabId/3d is gone.
    '/sites/$siteId/fabs/$fabId/3d',
  ]));
  expect(ids).not.toContain('/equipment/index');
  expect(ids).not.toContain('/fabs/$fabId/3d');
  expect(existsSync(new URL('../../src/routes/routeTree.gen.ts', import.meta.url))).toBe(false);
  expect(rootRoute.options.errorComponent, 'root error component must stay the route-level failure boundary').toBeTypeOf('function');
  expect(rootRoute.options.notFoundComponent, 'unknown URLs need the root 404 component').toBeTypeOf('function');
});

it('keeps preload staleness semantics and an explicit Router Register', () => {
  expect(router.options.defaultPreload).toBe('intent');
  expect(router.options.defaultPreloadStaleTime).toBe(0);
  const routerSource = readFileSync(join(process.cwd(), 'src/routes/router.tsx'), 'utf8');
  expect(routerSource).toContain('interface Register');
  expect(routerSource).toContain('router: typeof router');
});

it('retains an exact router pin without the file-router plugin or @ts-nocheck', () => {
  const packageJson = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
  expect(deps['@tanstack/react-router']).toMatch(/^\d+\.\d+\.\d+$/);
  expect(deps['@tanstack/router-plugin']).toBeUndefined();
  const lockfile = readFileSync(join(process.cwd(), 'pnpm-lock.yaml'), 'utf8');
  expect(lockfile).not.toContain('@tanstack/router-plugin');
  expect(lockfile).not.toContain('@tanstack/router-generator');
  const routeFiles = ['root.route.tsx', 'home.route.tsx', 'equipment.route.tsx', 'equipment-index.route.tsx', 'equipment-compare.route.tsx', 'fab-3d.route.tsx', 'route-tree.ts', 'router.tsx'];
  for (const file of routeFiles) {
    const source = readFileSync(join(process.cwd(), 'src/routes', file), 'utf8');
    expect(source, file + ' must not suppress type checking').not.toContain('@ts-nocheck');
  }
});
