import { expect, it } from 'vitest';
import { twinTranslator, persistTwinLanguage } from '../src/twin-i18n';
import { readTwinLanguage } from '../src/preferences';

it('honors URL, both original preference keys and browser language in order', () => {
  const storage = { getItem: (key: string) => key === 'semiconfab_lang' ? 'zh-CN' : null };
  expect(readTwinLanguage(storage, '?lang=en', 'zh-SG')).toBe('en');
  expect(readTwinLanguage(storage, '?lang=en-US', 'zh-SG')).toBe('en');
  expect(readTwinLanguage(storage, '', 'en-US')).toBe('zh');
  expect(readTwinLanguage({ getItem: () => null }, '', 'en-US')).toBe('en');
  expect(readTwinLanguage({ getItem: () => null }, '?lang=zh', 'en-US')).toBe('zh');
  expect(readTwinLanguage({ getItem: () => { throw new Error('blocked'); } }, '', 'zh-CN')).toBe('zh');
});

it('persists both original language keys and remains usable if storage is blocked', () => {
  const saved: Record<string, string> = {};
  persistTwinLanguage({ setItem: (key, value) => { saved[key] = value; } }, 'zh');
  expect(saved).toEqual({ semiconfab_lang: 'zh-CN', semicon_lang: 'zh' });
  expect(() => persistTwinLanguage({ setItem: () => { throw new Error('blocked'); } }, 'en')).not.toThrow();
});

it('translates controls, tool states and parameterized HUD labels without translating model IDs', () => {
  const en = twinTranslator('en');
  expect(en('跟随晶圆')).toBe('Follow a wafer');
  expect(en('运行')).toBe('Running');
  expect(en('回放加载失败：{0}', ['HTTP 503'])).toBe('Replay load failed: HTTP 503');
  expect(en('TWINSCAN NXE:3400C')).toBe('TWINSCAN NXE:3400C');
  expect(twinTranslator('zh')('跟随晶圆')).toBe('跟随晶圆');
});
