export interface Preferences {
  language: 'zh' | 'en';
  theme: 'light' | 'dark';
}
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
  const language =
    new URLSearchParams(search).get('lang') ?? get('semiconfab_lang') ?? get('semicon_lang');
  const override = new URLSearchParams(search).get('theme');
  const theme = override === 'dark' || override === 'light' ? override : get('semicon_theme');
  return { language: language === 'en' ? 'en' : 'zh', theme: theme === 'dark' ? 'dark' : 'light' };
}
