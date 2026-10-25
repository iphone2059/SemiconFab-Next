import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { TwinLanguage } from '../twin-i18n';
import { readPreferences, type Preferences } from '../preferences';

function initialLanguage(): TwinLanguage {
  if (typeof window === 'undefined') return 'zh';
  try {
    const url = new URL(location.href).searchParams.get('lang');
    if (url === 'en' || url === 'en-US') return 'en';
    if (url === 'zh' || url === 'zh-CN') return 'zh';
    const stored = localStorage.getItem('semiconfab_lang') ?? localStorage.getItem('semicon_lang');
    if (stored === 'en' || stored === 'en-US') return 'en';
    if (stored === 'zh' || stored === 'zh-CN') return 'zh';
    return navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
  } catch {
    return navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
  }
}
export const localeSlice = createSlice({
  name: 'locale',
  initialState: (): Preferences => {
    let theme: Preferences['theme'] = 'light';
    if (typeof window !== 'undefined') {
      try { theme = readPreferences(localStorage, location.search).theme; } catch { /* storage denied */ }
    }
    return { language: initialLanguage(), theme };
  },
  reducers: {
    preferencesSet(_state, action: PayloadAction<Preferences>) { return action.payload; },
    languageSet(state, action: PayloadAction<TwinLanguage>) { state.language = action.payload; },
    languageToggled(state) { state.language = state.language === 'zh' ? 'en' : 'zh'; },
    themeToggled(state) { state.theme = state.theme === 'light' ? 'dark' : 'light'; },
  },
});
export const localeActions = localeSlice.actions;
