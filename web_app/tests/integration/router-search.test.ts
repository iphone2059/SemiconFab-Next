import { expect, it } from 'vitest';
import { searchToQueryString } from '@/routes/route-search';
import { catalogSearchFrom, catalogSearchPatch } from '@/catalog/catalog-search';
import { twinModalFrom, twinModeFrom, twinSiteIdFrom } from '@/twin/twin-search';

it('parses catalog filters and bounded, deduplicated comparison ids from search', () => {
  const first = '3acd7b05-e6e8-5312-bb5b-045e7dd3074b';
  const second = 'e3021724-ec73-534e-be7c-ba3374f4ddb8';
  const parsed = catalogSearchFrom({
    domain: 'osat',
    category: 'lithography',
    q: 'NXT:2050i',
    hideDrafts: 1,
    compare: [first, first, second, 'not-a-uuid', 'third'].slice(0, 4).join(','),
  });
  expect(parsed).toEqual({
    domain: 'OSAT',
    category: 'lithography',
    query: 'NXT:2050i',
    hideDrafts: true,
    compare: [first, second],
  });
  expect(catalogSearchFrom({}).domain).toBe('ALL');
  expect(catalogSearchFrom({ domain: 'bogus' }).domain).toBe('ALL');
});

it('builds a minimal canonical search patch and round-trips it', () => {
  const patch = catalogSearchPatch({
    domain: 'FAB',
    category: '',
    query: '',
    hideDrafts: false,
    selected: ['id-1'],
    language: 'en',
    theme: 'dark',
  });
  expect(patch).toEqual({
    domain: 'fab',
    category: undefined,
    q: undefined,
    hideDrafts: undefined,
    compare: 'id-1',
    lang: 'en-US',
    theme: 'dark',
  });
  const query = searchToQueryString({ ...patch });
  expect(query).toBe('domain=fab&compare=id-1&lang=en-US&theme=dark');
});

it('coerces valid Twin deep-link params and rejects malformed ones', () => {
  expect(twinModeFrom({ mode: 'research' })).toBe('research');
  expect(twinModeFrom({ mode: 'bogus' })).toBeUndefined();
  expect(twinModalFrom({ modal: 'database' })).toBe('database');
  expect(twinModalFrom({ modal: 'bogus' })).toBeUndefined();
  expect(twinSiteIdFrom({ siteId: 123 })).toBe('123');
  expect(twinSiteIdFrom({})).toBeUndefined();
});
