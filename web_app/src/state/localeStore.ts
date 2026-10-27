import { create } from 'zustand';
import type { TwinLanguage } from '../features/twin/twin-i18n';
import { readPreferences, readTwinLanguage, type Preferences } from '../preferences';

function initialLocale(): Preferences {
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

export const useLocaleStore = create<LocaleStoreState>(() => initialLocale());

export const localeActions = {
  preferencesSet: (payload: Preferences) => useLocaleStore.setState(payload, true),
  languageSet: (language: TwinLanguage) => useLocaleStore.setState({ language }),
  languageToggled: () => useLocaleStore.setState((state) => ({ language: state.language === 'zh' ? 'en' : 'zh' })),
  themeToggled: () => useLocaleStore.setState((state) => ({ theme: state.theme === 'light' ? 'dark' : 'light' })),
};

export const resetLocaleStore = (): void => useLocaleStore.setState(initialLocale(), true);
