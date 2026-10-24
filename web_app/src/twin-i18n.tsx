import { createContext, useContext, useEffect, useMemo, type PropsWithChildren } from 'react';
import { useAppDispatch, useAppSelector } from './store/hooks';
import { localeActions } from './store/localeSlice';
import { TWIN_EN } from './twin-translations';

export type TwinLanguage = 'zh' | 'en';
const normalize = (value: string | null): TwinLanguage | undefined => value === 'en' ? 'en'
  : value === 'zh' || value === 'zh-CN' || value === 'zh-TW' ? 'zh' : undefined;

export function readTwinLanguage(storage: Pick<Storage, 'getItem'>, search: string, browserLanguage: string): TwinLanguage {
  const explicit = normalize(new URLSearchParams(search).get('lang'));
  if (explicit) return explicit;
  try {
    const saved = normalize(storage.getItem('semiconfab_lang')) ?? normalize(storage.getItem('semicon_lang'));
    if (saved) return saved;
  } catch { /* Storage denial must not prevent opening the FAB. */ }
  return browserLanguage.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

export function persistTwinLanguage(storage: Pick<Storage, 'setItem'>, language: TwinLanguage): void {
  try {
    storage.setItem('semiconfab_lang', language === 'zh' ? 'zh-CN' : 'en');
    storage.setItem('semicon_lang', language);
  } catch { /* The current page can still switch language. */ }
}

const reverse = new Map(Object.entries(TWIN_EN).map(([zh, en]) => [en, zh]));
export function twinTranslator(language: TwinLanguage) {
  return (text: string, parameters: readonly unknown[] = []): string => {
    const translated = language === 'en' ? TWIN_EN[text] ?? text : reverse.get(text) ?? text;
    return translated.replace(/\{(\d+)\}/g, (_, index: string) => String(parameters[Number(index)] ?? ''));
  };
}

const TwinLocale = createContext({ language: 'zh' as TwinLanguage, t: twinTranslator('zh'), toggleLanguage: () => {} });
export const useTwinLocale = () => useContext(TwinLocale);

export function TwinLocaleProvider({ children }: PropsWithChildren) {
  const dispatch = useAppDispatch();
  const language = useAppSelector((state) => state.locale.language);
  useEffect(() => {
    try { persistTwinLanguage(localStorage, language); } catch { /* Storage getter can also be denied. */ }
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
    document.documentElement.dataset.lang = language;
    const url = new URL(location.href);
    url.searchParams.set('lang', language === 'zh' ? 'zh-CN' : 'en');
    history.replaceState({}, '', url);
  }, [language]);
  const value = useMemo(() => ({ language, t: twinTranslator(language), toggleLanguage: () => dispatch(localeActions.languageToggled()) }), [language, dispatch]);
  return <TwinLocale.Provider value={value}>{children}</TwinLocale.Provider>;
}
