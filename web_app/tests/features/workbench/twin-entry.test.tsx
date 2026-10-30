// @vitest-environment jsdom
import { resetWorkbenchState } from '../../../tests/support/reset-ui-atoms';
import { createAtomTestScope } from '../../../tests/support/atom-scope';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import WorkbenchApp from '@/workbench/workbench';
import { workbenchActions } from '@/workbench/workbench.atom';
import { createTestRuntime, seedSites, ResourceTestProviders } from '../../support/resource-test-runtime.tsx';

const { registry, render } = createAtomTestScope();
const site = { siteId: 'site-1', code: 'SITE-1', templateHash: 'hash', fabs: [{ fabId: 'fab-1', code: 'FAB-1' }] };

beforeEach(() => resetWorkbenchState(registry));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('keeps the website entrance free of 3D preview rendering and links to the canonical 3D URL', () => {
  // A client render (unlike static markup) reads the live Effect Atom snapshot, so
  // mirror the hydrated site selection before mounting the entrance.
  workbenchActions.siteIdSet(registry, 'site-1');
  // Keep background refetches pending instead of touching the network.
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  const queryClient = createTestRuntime(registry);
  seedSites(queryClient, [site]);
  const { container } = render(
    <ResourceTestProviders runtime={queryClient}>
      <WorkbenchApp />
    </ResourceTestProviders>,
  );
  expect(container.innerHTML).toContain('href="/sites/site-1/fabs/fab-1/3d"');
  expect(container.innerHTML).toContain('href="/equipment"');
  expect(container.innerHTML).not.toContain('<canvas');
  expect(container.innerHTML).not.toContain('SITE DIGITAL VIEW');
  expect(container.innerHTML).not.toContain('预览');
});

it('R5.4-03-T10: the Workbench 3D link carries the composite (siteId, fabId) identity', () => {
  workbenchActions.siteIdSet(registry, 'site-1');
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
  const queryClient = createTestRuntime(registry);
  seedSites(queryClient, [site]);
  const { container } = render(
    <ResourceTestProviders runtime={queryClient}>
      <WorkbenchApp />
    </ResourceTestProviders>,
  );
  const link = container.querySelector('a[target="_blank"]');
  expect(link, 'the 3D FAB navigation link must exist').not.toBeNull();
  expect(link?.getAttribute('href')).toBe('/sites/site-1/fabs/fab-1/3d');
  // Both identity components are present; a single-id route is not enough.
  expect(link?.getAttribute('href')).toContain('site-1');
  expect(link?.getAttribute('href')).toContain('fab-1');
});
