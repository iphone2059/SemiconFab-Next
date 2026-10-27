import { expect, it } from 'vitest';
import { classNames } from '../src/class-names';

it('omits falsy and boolean values while keeping string and numeric tokens', () => {
  expect(classNames('', null, undefined, false, true, 0, NaN, 'panel', -2, 3)).toBe('panel -2 3');
  expect(classNames()).toBe('');
});

it('flattens nested readonly arrays without mutating their order or contents', () => {
  const nested = Object.freeze(['primary', Object.freeze([false, 'selected', 2])] as const);
  expect(classNames('button', nested, ['last'])).toBe('button primary selected 2 last');
  expect(nested[1]).toEqual([false, 'selected', 2]);
});

it('includes object keys only when their values are truthy, matching clsx semantics', () => {
  expect(classNames('panel', { active: true, hidden: false, loading: 1, empty: '', data: [], missing: null })).toBe('panel active loading data');
});

it('keeps existing token text, duplicates and inherited enumerable condition keys', () => {
  const flags = Object.assign(Object.create({ inherited: true }) as Record<string, unknown>, { own: true });
  expect(classNames('a b', 'a', flags)).toBe('a b a own inherited');
});

it('traverses large arrays without spreading their elements into function arguments', () => {
  const values = Array.from({ length: 150_000 }, (_, index) => index === 149_999 ? 'last' : false);
  expect(classNames(values)).toBe('last');
});
