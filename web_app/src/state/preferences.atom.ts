export interface Preferences {
  language: 'zh' | 'en';
  theme: 'light' | 'dark';
}
export const languageTag = (language: Preferences['language']): 'en-US' | 'zh-CN' => language === 'en' ? 'en-US' : 'zh-CN';
export function readTwinLanguage(storage: Pick<Storage, 'getItem'>, search: string, browserLanguage: string): Preferences['language'] {
  const normalize = (value: string | null): Preferences['language'] | undefined => value === 'en' || value === 'en-US' ? 'en'
    : value === 'zh' || value === 'zh-CN' || value === 'zh-TW' ? 'zh' : undefined;
  const explicit = normalize(new URLSearchParams(search).get('lang'));
  if (explicit) return explicit;
  try {
    const saved = normalize(storage.getItem('semiconfab_lang')) ?? normalize(storage.getItem('semicon_lang'));
    if (saved) return saved;
  } catch { /* Storage denial must not prevent opening the FAB. */ }
  return browserLanguage.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

export function readPreferences(storage: Pick<Storage, 'getItem'>, search: string): Preferences {
  const get = (key: string) => {
    try {
      return storage.getItem(key);
    } catch {
      return null;
    }
  };
  const override = new URLSearchParams(search).get('theme');
  const theme = override === 'dark' || override === 'light' ? override : get('semicon_theme');
  return { language: readTwinLanguage(storage, search, 'zh-CN'), theme: theme === 'dark' ? 'dark' : 'light' };
}
