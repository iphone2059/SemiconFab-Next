import { expect, it } from 'vitest';
import {
  canonicalizePathname,
  fab3dPath,
  legacyAliasTarget,
  resolveCanonicalPath,
  routeViewForPathname,
  staticRedirectPath,
} from '../../src/app/router/url-mapping';

it('keeps canonical paths canonical and promotes the FAB overview entry to /3d', () => {
  expect(resolveCanonicalPath('/')).toBe('/');
  expect(resolveCanonicalPath('/equipment')).toBe('/equipment');
  expect(resolveCanonicalPath('/equipment/')).toBe('/equipment');
  expect(resolveCanonicalPath('/equipment/compare')).toBe('/equipment/compare');
  expect(resolveCanonicalPath('/fabs/FAB-01')).toBe('/fabs/FAB-01/3d');
  expect(resolveCanonicalPath('/fabs/FAB-01/3d')).toBe('/fabs/FAB-01/3d');
  expect(canonicalizePathname('/fabs/FAB-01/3d/')).toBe('/fabs/FAB-01/3d');
});

it('maps every permanent legacy alias to its canonical target path', () => {
  for (const path of ['/twin', '/twin.html', '/preview', '/preview.html']) {
    expect(legacyAliasTarget(path)).toBe('twin');
    expect(resolveCanonicalPath(path, 'FAB-01')).toBe('/fabs/FAB-01/3d');
  }
  for (const path of ['/catalog', '/catalog-demo', '/catalog-demo.html']) {
    expect(legacyAliasTarget(path)).toBe('equipment');
    expect(resolveCanonicalPath(path)).toBe('/equipment');
  }
  for (const path of ['/compare', '/compare.html']) {
    expect(legacyAliasTarget(path)).toBe('compare');
    expect(resolveCanonicalPath(path)).toBe('/equipment/compare');
  }
  expect(legacyAliasTarget('/workbench')).toBe('workbench');
  expect(resolveCanonicalPath('/workbench')).toBe('/');
});

it('does not invent a twin target before the first FAB id is resolved', () => {
  expect(resolveCanonicalPath('/twin')).toBeUndefined();
  expect(resolveCanonicalPath('/preview.html')).toBeUndefined();
  expect(staticRedirectPath('equipment')).toBe('/equipment');
  expect(staticRedirectPath('compare')).toBe('/equipment/compare');
  expect(staticRedirectPath('workbench')).toBe('/');
  expect(fab3dPath('FAB 01')).toBe('/fabs/FAB%2001/3d');
});

it('leaves unknown and reserved future paths unmapped', () => {
  for (const path of ['/unknown', '/equipment/3acd7b05', '/amhs', '/alarms', '/fabs', '/fabs/FAB-01/b1']) {
    expect(resolveCanonicalPath(path)).toBeUndefined();
    expect(legacyAliasTarget(path)).toBeUndefined();
  }
});

it('classifies views for the transitional catalog URL hydration code', () => {
  expect(routeViewForPathname('/')).toBe('workbench');
  expect(routeViewForPathname('/workbench')).toBe('workbench');
  expect(routeViewForPathname('/equipment')).toBe('catalog');
  expect(routeViewForPathname('/catalog-demo.html')).toBe('catalog');
  expect(routeViewForPathname('/equipment/compare')).toBe('compare');
  expect(routeViewForPathname('/compare.html')).toBe('compare');
  expect(routeViewForPathname('/fabs/FAB-01/3d')).toBe('twin');
  expect(routeViewForPathname('/preview')).toBe('twin');
});
