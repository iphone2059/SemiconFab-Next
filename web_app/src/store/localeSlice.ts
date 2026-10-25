import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { TwinLanguage } from '../twin-i18n';
import { readPreferences, readTwinLanguage, type Preferences } from '../preferences';
export const localeSlice = createSlice({
  name: 'locale',
  initialState: (): Preferences => {
    if (typeof window === 'undefined') return { language: 'zh', theme: 'light' };
    const storage = { getItem: (key: string) => { try { return localStorage.getItem(key); } catch { return null; } } };
    return { language: readTwinLanguage(storage, location.search, navigator.language), theme: readPreferences(storage, location.search).theme };
  },
  reducers: {
    preferencesSet(_state, action: PayloadAction<Preferences>) { return action.payload; },
    languageSet(state, action: PayloadAction<TwinLanguage>) { state.language = action.payload; },
    languageToggled(state) { state.language = state.language === 'zh' ? 'en' : 'zh'; },
    themeToggled(state) { state.theme = state.theme === 'light' ? 'dark' : 'light'; },
  },
});
export const localeActions = localeSlice.actions;
