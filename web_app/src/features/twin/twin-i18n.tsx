import { createContext, useContext, useEffect, useMemo, type PropsWithChildren } from 'react';
import { useLocaleStore, localeActions } from '../../state/localeStore';
import { TWIN_EN } from '../../twin-translations';
import { GENERATED_TWIN_EN } from '../../twin-translations.generated';
import { languageTag } from '../../preferences';

export type TwinLanguage = 'zh' | 'en';
export function persistTwinLanguage(storage: Pick<Storage, 'setItem'>, language: TwinLanguage): void {
  try {
    storage.setItem('semiconfab_lang', languageTag(language));
    storage.setItem('semicon_lang', language);
  } catch { /* The current page can still switch language. */ }
}

// Frozen-source copy wins for every zh string present in the extracted inventory; the
// hand-written map only augments Next-specific labels the source never had.
const TWIN_EN_ALL: Readonly<Record<string, string>> = { ...TWIN_EN, ...GENERATED_TWIN_EN };
const reverse = new Map(Object.entries(TWIN_EN_ALL).map(([zh, en]) => [en, zh]));
export function twinTranslator(language: TwinLanguage) {
  return (text: string, parameters: readonly unknown[] = []): string => {
    const translated = language === 'en' ? TWIN_EN_ALL[text] ?? text : reverse.get(text) ?? text;
    return translated.replace(/\{(\d+)\}/g, (_, index: string) => String(parameters[Number(index)] ?? ''));
  };
}

const TwinLocale = createContext({ language: 'zh' as TwinLanguage, t: twinTranslator('zh'), toggleLanguage: () => {} });
export const useTwinLocale = () => useContext(TwinLocale);

export function TwinLocaleProvider({ children }: PropsWithChildren) {
  const language = useLocaleStore((state) => state.language);
  useEffect(() => {
    try { persistTwinLanguage(localStorage, language); } catch { /* Storage getter can also be denied. */ }
    document.documentElement.lang = languageTag(language);
    document.documentElement.dataset.lang = language;
    // The Twin page writes lang through TanStack Router search; this provider
    // only persists the preference and mirrors the document/attributes.
  }, [language]);
  const value = useMemo(() => ({ language, t: twinTranslator(language), toggleLanguage: () => localeActions.languageToggled() }), [language]);
  return <TwinLocale.Provider value={value}>{children}</TwinLocale.Provider>;
}
