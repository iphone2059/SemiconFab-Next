import { expect, it } from 'vitest';
import { canonicalViewForPathname, fab3dPath } from '@/routes/route-url-mapping';

it('maps only the canonical V2.1 URLs', () => {
  expect(canonicalViewForPathname('/')).toBe('workbench');
  expect(canonicalViewForPathname('/equipment')).toBe('catalog');
  expect(canonicalViewForPathname('/equipment/')).toBe('catalog');
  expect(canonicalViewForPathname('/equipment/compare')).toBe('compare');
  expect(canonicalViewForPathname('/fabs/FAB-01/3d')).toBe('twin');
  expect(canonicalViewForPathname('/fabs/FAB-01/3d/')).toBe('twin');
  expect(fab3dPath('FAB 01')).toBe('/fabs/FAB%2001/3d');
});

it('returns no mapping for deleted legacy addresses (no redirects)', () => {
  for (const path of [
    '/twin', '/twin.html', '/preview', '/preview.html',
    '/catalog', '/catalog-demo', '/catalog-demo.html',
    '/compare', '/compare.html', '/workbench',
  ]) {
    expect(canonicalViewForPathname(path)).toBeUndefined();
  }
});

it('leaves unknown and reserved future paths unmapped', () => {
  for (const path of ['/unknown', '/equipment/3acd7b05', '/amhs', '/alarms', '/fabs', '/fabs/FAB-01', '/fabs/FAB-01/b1']) {
    expect(canonicalViewForPathname(path)).toBeUndefined();
  }
});
