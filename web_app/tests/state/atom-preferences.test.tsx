// @vitest-environment jsdom
import { RegistryContext, useAtomValue } from '@effect/atom-react';
import * as AtomRegistry from 'effect/reactivity/AtomRegistry';
import { Layer } from 'effect';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useContext } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { AppProviders } from '@/app/app-providers';
import type { RouterSearch } from '@/routes/route-search';
import { useCatalogRouteState } from '@/catalog/use-catalog-route-state';
import { TwinLocaleProvider } from '@/twin/twin-i18n';
import { applicationRuntime, createApplicationRuntime } from '@/app/app-runtime';
import { localeActions, localeAtom } from '@/state/locale.atom';
import { seedSites } from '../support/resource-test-runtime.tsx';

const applicationRegistry = applicationRuntime.registry;
const createApplicationRegistry = () => createApplicationRuntime({ layer: Layer.empty }).registry;

const noop = () => {};
const entries: readonly { recordId: string; category: string }[] = [];
const emptySearch: RouterSearch = {};

function PreferenceView({ search = emptySearch }: { search?: RouterSearch }) {
  const registry = useContext(RegistryContext);
  const { preferences } = useCatalogRouteState({ initialView: 'catalog', search, onSearchChange: noop, onViewChange: noop, entries });
  return <><output>{preferences.language}/{preferences.theme}</output>
    <button onClick={() => localeActions.languageToggled(registry)}>Language</button>
    <button onClick={() => localeActions.themeToggled(registry)}>Theme</button></>;
}

function RegistryView() {
  const registry = useContext(RegistryContext);
  const locale = useAtomValue(localeAtom);
  return <><output>{locale.language}/{locale.theme}</output><button onClick={() => localeActions.themeToggled(registry)}>Theme</button></>;
}

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });

it('initializes a supplied registry from current storage on its first preference read', () => {
  localStorage.setItem('semiconfab_lang', 'en-US');
  localStorage.setItem('semicon_theme', 'dark');
  const registry = AtomRegistry.make();
  const view = render(<RegistryContext.Provider value={registry}><RegistryView /></RegistryContext.Provider>);
  expect(screen.getByRole('status').textContent).toBe('en/dark');
  view.unmount(); registry.dispose();
});

it('honors preference storage priority, then URL input, and persists both language keys and theme', () => {
  localStorage.setItem('semiconfab_lang', 'en-US');
  localStorage.setItem('semicon_lang', 'zh');
  localStorage.setItem('semicon_theme', 'dark');
  const registry = createApplicationRegistry();
  expect(registry.get(localeAtom)).toEqual({ language: 'en', theme: 'dark' });
  const view = render(<RegistryContext.Provider value={registry}><TwinLocaleProvider>
    <PreferenceView search={{ lang: 'zh-CN', theme: 'light' }} />
  </TwinLocaleProvider></RegistryContext.Provider>);
  expect(screen.getByRole('status').textContent).toBe('zh/light');
  fireEvent.click(screen.getByText('Language'));
  fireEvent.click(screen.getByText('Theme'));
  expect(screen.getByRole('status').textContent).toBe('en/dark');
  expect(localStorage.getItem('semiconfab_lang')).toBe('en-US');
  expect(localStorage.getItem('semicon_lang')).toBe('en');
  expect(localStorage.getItem('semicon_theme')).toBe('dark');
  expect(document.documentElement.lang).toBe('en-US');
  view.unmount(); registry.dispose();
});

it('still applies explicit language and theme when storage reads and writes are denied', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
  const registry = createApplicationRegistry();
  const view = render(<RegistryContext.Provider value={registry}><TwinLocaleProvider>
    <PreferenceView search={{ lang: 'zh-TW', theme: 'dark' }} />
  </TwinLocaleProvider></RegistryContext.Provider>);
  expect(screen.getByRole('status').textContent).toBe('zh/dark');
  fireEvent.click(screen.getByText('Language'));
  expect(screen.getByRole('status').textContent).toBe('en/dark');
  view.unmount(); registry.dispose();
});

it('shares exactly the supplied registry through StrictMode and follows provider replacement', () => {
  const firstRuntime = createApplicationRuntime({ layer: Layer.empty });
  const secondRuntime = createApplicationRuntime({ layer: Layer.empty });
  const first = firstRuntime.registry;
  const second = secondRuntime.registry;
  localeActions.preferencesSet(first, { language: 'zh', theme: 'light' });
  localeActions.preferencesSet(second, { language: 'en', theme: 'dark' });
  seedSites(firstRuntime, []);
  seedSites(secondRuntime, []);
  const view = render(<AppProviders runtime={firstRuntime}><RegistryView /></AppProviders>, { reactStrictMode: true });
  fireEvent.click(screen.getByText('Theme'));
  expect(first.get(localeAtom)).toEqual({ language: 'zh', theme: 'dark' });
  view.rerender(<AppProviders runtime={secondRuntime}><RegistryView /></AppProviders>);
  expect(screen.getByRole('status').textContent).toBe('en/dark');
  fireEvent.click(screen.getByText('Theme'));
  expect(second.get(localeAtom)).toEqual({ language: 'en', theme: 'light' });
  expect(first.get(localeAtom)).toEqual({ language: 'zh', theme: 'dark' });
  view.unmount();
  // Provider cleanup releases subscriptions; registry disposal belongs to its owner.
  localeActions.themeToggled(first);
  expect(first.get(localeAtom).theme).toBe('light');
  first.dispose(); second.dispose();
  void firstRuntime.dispose(); void secondRuntime.dispose();
});

it('keeps the default application registry across provider remounts', () => {
  seedSites(applicationRuntime, []);
  localeActions.preferencesSet(applicationRegistry, { language: 'en', theme: 'dark' });
  const first = render(<AppProviders><RegistryView /></AppProviders>);
  first.unmount();
  const second = render(<AppProviders><RegistryView /></AppProviders>);
  expect(screen.getByRole('status').textContent).toBe('en/dark');
  fireEvent.click(screen.getByText('Theme'));
  expect(applicationRegistry.get(localeAtom).theme).toBe('light');
  second.unmount(); applicationRuntime.registry.reset();
});
