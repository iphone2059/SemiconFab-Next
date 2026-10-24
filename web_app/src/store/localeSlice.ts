import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { TwinLanguage } from '../twin-i18n';

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
  initialState: { language: initialLanguage() as TwinLanguage },
  reducers: {
    languageSet(state, action: PayloadAction<TwinLanguage>) { state.language = action.payload; },
    languageToggled(state) { state.language = state.language === 'zh' ? 'en' : 'zh'; },
  },
});
export const localeActions = localeSlice.actions;
