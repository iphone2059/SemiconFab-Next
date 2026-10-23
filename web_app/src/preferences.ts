export interface Preferences {
  language: 'zh' | 'en';
  theme: 'light' | 'dark';
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
