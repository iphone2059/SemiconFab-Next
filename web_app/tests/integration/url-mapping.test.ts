import { expect, it } from 'vitest';
import { canonicalViewForPathname, fab3dPath } from '@/routes/route-url-mapping';

it('maps only the canonical composite-identity URLs', () => {
  expect(canonicalViewForPathname('/')).toBe('workbench');
  expect(canonicalViewForPathname('/equipment')).toBe('catalog');
  expect(canonicalViewForPathname('/equipment/')).toBe('catalog');
  expect(canonicalViewForPathname('/equipment/compare')).toBe('compare');
  expect(canonicalViewForPathname('/sites/site-1/fabs/FAB-01/3d')).toBe('twin');
  expect(canonicalViewForPathname('/sites/site-1/fabs/FAB-01/3d/')).toBe('twin');
  expect(fab3dPath('site 1', 'FAB 01')).toBe('/sites/site%201/fabs/FAB%2001/3d');
});

it('returns no mapping for deleted legacy addresses (no redirects)', () => {
  for (const path of [
    '/twin', '/twin.html', '/preview', '/preview.html',
    '/catalog', '/catalog-demo', '/catalog-demo.html',
    '/compare', '/compare.html', '/workbench',
    // R5.4-03: the pre-composite single-id 3D route is deleted, not aliased.
    '/fabs/FAB-01/3d', '/fabs/FAB-01/3d/',
  ]) {
    expect(canonicalViewForPathname(path)).toBeUndefined();
  }
});

it('leaves unknown and reserved future paths unmapped', () => {
  for (const path of [
    '/unknown', '/equipment/3acd7b05', '/amhs', '/alarms', '/fabs', '/fabs/FAB-01', '/fabs/FAB-01/b1',
    '/sites', '/sites/site-1/fabs', '/sites/site-1/fabs/FAB-01', '/sites/site-1/fabs/FAB-01/3d/extra',
  ]) {
    expect(canonicalViewForPathname(path)).toBeUndefined();
  }
});
