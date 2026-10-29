import * as Atom from 'effect/reactivity/Atom';
import type * as AtomRegistry from 'effect/reactivity/AtomRegistry';
import type { TwinLanguage } from '@/localization/language';
import { readPreferences, readTwinLanguage, type Preferences } from '@/state/preferences.atom';

export function initialLocale(): Preferences {
  if (typeof window === 'undefined') return { language: 'zh', theme: 'light' };
  const storage = {
    getItem: (key: string) => {
      try { return localStorage.getItem(key); } catch { return null; }
    },
  };
  // URL/search overrides are applied by the Router-aware catalog/Twin pages;
  // the store itself initializes from persisted preferences only.
  return {
    language: readTwinLanguage(storage, '', navigator.language),
    theme: readPreferences(storage, '').theme,
  };
}

export interface LocaleStoreState extends Preferences {}

// Initialize at the first read in each registry, including an injected registry
// created after this module was loaded. A module-time preference snapshot goes stale.
export const localeAtom = Atom.writable(
  () => initialLocale(),
  (context, value: LocaleStoreState) => context.setSelf(value),
).pipe(Atom.keepAlive);

export const localeActions = {
  preferencesSet: (registry: AtomRegistry.AtomRegistry, payload: Preferences): void => registry.set(localeAtom, payload),
  languageSet: (registry: AtomRegistry.AtomRegistry, language: TwinLanguage): void => registry.update(localeAtom, state => ({ ...state, language })),
  languageToggled: (registry: AtomRegistry.AtomRegistry): void => registry.update(localeAtom,  (state): LocaleStoreState => ({ ...state, language: state.language === 'zh' ? 'en' : 'zh' })),
  themeToggled: (registry: AtomRegistry.AtomRegistry): void => registry.update(localeAtom,  (state): LocaleStoreState => ({ ...state, theme: state.theme === 'light' ? 'dark' : 'light' })),
};
