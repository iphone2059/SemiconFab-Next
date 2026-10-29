import { afterAll, expect, it } from 'vitest';
import * as Atom from 'effect/reactivity/Atom';
import * as AtomRegistry from 'effect/reactivity/AtomRegistry';
import * as page from '@/twin/twin-page.atom';
import * as locale from '@/state/locale.atom';

const registry = AtomRegistry.make();
const other = AtomRegistry.make();
afterAll(() => { registry.dispose(); other.dispose(); });

it('keeps replacement FAB scope isolated in the actual application registry', () => {
  // A singleton store (or a facade around one) cannot provide registry isolation.
  expect(Atom.isAtom(page.twinPageAtom)).toBe(true);
  page.twinPageActions.liveScopeActivated(registry, { siteId: 'site-a', fabId: 'fab-a' });
  page.twinPageActions.liveSnapshotReceived(registry, { scope: { siteId: 'site-a', fabId: 'fab-a' }, states: ['down'], updatedAt: 'a' });
  page.twinPageActions.liveScopeActivated(registry, { siteId: 'site-b', fabId: 'fab-b' });
  page.twinPageActions.liveSnapshotReceived(registry, { scope: { siteId: 'site-a', fabId: 'fab-a' }, states: ['down'], updatedAt: 'late' });
  expect(registry.get(page.twinPageAtom).liveStatusScope).toEqual({ siteId: 'site-b', fabId: 'fab-b' });
  expect(registry.get(page.twinPageAtom).statusFeed).toBeUndefined();
  expect(other.get(page.twinPageAtom).liveStatusScope).toBeUndefined();
});

it('keeps language and theme preferences local to the supplied registry', () => {
  expect(Atom.isAtom(locale.localeAtom)).toBe(true);
  locale.localeActions.preferencesSet(registry, { language: 'en', theme: 'dark' });
  locale.localeActions.languageToggled(registry);
  expect(registry.get(locale.localeAtom)).toEqual({ language: 'zh', theme: 'dark' });
  expect(other.get(locale.localeAtom)).not.toEqual({ language: 'zh', theme: 'dark' });
});
