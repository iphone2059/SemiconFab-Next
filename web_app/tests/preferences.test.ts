import { expect, it } from 'vitest';
import { readPreferences } from '../src/preferences';

const storage = (values: Record<string, string>) => ({
  getItem: (key: string) => values[key] ?? null,
});
it('reads both legacy language keys and lets an explicit URL override them', () => {
  expect(readPreferences(storage({ semicon_lang: 'en', semicon_theme: 'light' }), '')).toEqual({
    language: 'en',
    theme: 'light',
  });
  expect(
    readPreferences(storage({ semiconfab_lang: 'zh', semicon_theme: 'dark' }), '?lang=en'),
  ).toEqual({ language: 'en', theme: 'dark' });
  expect(readPreferences(storage({ semicon_theme: 'light' }), '?theme=dark')).toEqual({
    language: 'zh',
    theme: 'dark',
  });
});
it('remains usable when browser storage is denied', () => {
  expect(
    readPreferences(
      {
        getItem: () => {
          throw new Error('denied');
        },
      },
      '',
    ),
  ).toEqual({ language: 'zh', theme: 'light' });
});
