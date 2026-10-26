import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

type SourceEntry = {
  sha256: string;
  bytes: number;
  lines: number;
  inlineScript?: { start: number; end: number };
  dictionaryLines?: Record<string, { start: number; end: number }>;
};
type DictionaryKey = { key: string; en: string; zhCN: string; attributes: string[] };
type DynamicPair = { id: string; zhCN: string; en: string; sourceLine: number };
type DictionaryGap = {
  kind: 'dictionary-key';
  key: string;
  attributes: string[];
  sourceLines: number[];
  sourceLine: number;
  locales: string[];
  reason: string;
};
type CopyGap = {
  kind: 'zh-only-copy';
  surface: string;
  zhCN: string;
  en: null;
  sourceLine: number;
  reason: string;
};
type MissingEntry = DictionaryGap | CopyGap;
type SkippedEntry = { kind: string; sourceLine: number; reason: string; snippet?: string };
type Fixture = {
  generatedBy: string;
  source: Record<string, SourceEntry>;
  locales: string[];
  excludedLocales: string[];
  frozenLocaleIds: string[];
  dictionaryKeyCounts: Record<string, number>;
  attributeNames: string[];
  attributeCounts: Record<string, number>;
  missingKinds: Record<string, string>;
  skippedKinds: Record<string, string>;
  counts: {
    keys: number;
    attributeRefs: number;
    uniqueAttributeKeys: number;
    missingDictionaryKeys: number;
    dynamic: number;
    missing: number;
    skipped: number;
  };
  rules: Record<string, string>;
  keys: DictionaryKey[];
  dynamic: DynamicPair[];
  missing: MissingEntry[];
  skipped: SkippedEntry[];
};

const fixture = JSON.parse(
  readFileSync(new URL('../assets/original-twin-i18n.json', import.meta.url), 'utf8'),
) as Fixture;
const manifest = JSON.parse(
  readFileSync(new URL('../../docs/migration/twin-parity/source-manifest.json', import.meta.url), 'utf8'),
) as { source_sha256: Record<string, string> };

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const PLACEHOLDER = '$' + '{';
const dynamicIn = (prefix: string) => fixture.dynamic.filter((entry) => entry.id.startsWith(prefix + '.'));
const placeholderCount = (value: string) => (value.match(/\$\{/g) ?? []).length;
const bySourceLine = (left: { sourceLine: number }, right: { sourceLine: number }) => left.sourceLine - right.sourceLine;

it('pins the frozen source hashes and emits only the en and zh-CN bytes', () => {
  const expected: Record<string, string> = {
    'twin.html': '633598e4ab21c13eab440f65fb1c427bad08d147b2218f320bedb2770d32fc30',
    'js/translations.js': 'de7d8da63739647b6635520ac9b2fa52d7b4c07930de20a53a20683362006f69',
    'js/i18n.js': '195551a502c0446b2735f513f4365899e93272fa709c60d150701243dddfceef',
  };
  for (const [file, hash] of Object.entries(expected)) {
    expect(fixture.source[file]?.sha256).toBe(hash);
    expect(manifest.source_sha256[file]).toBe(hash);
    expect(fixture.source[file]?.bytes).toBeGreaterThan(0);
    expect(fixture.source[file]?.lines).toBeGreaterThan(0);
  }
  expect(fixture.locales).toEqual(['en', 'zh-CN']);
  expect(fixture.excludedLocales).toEqual(['zh-TW', 'ja', 'ko', 'de', 'fr', 'it', 'es']);
  expect(fixture.frozenLocaleIds).toHaveLength(9);
  expect(fixture.dictionaryKeyCounts).toEqual({ en: 827, 'zh-CN': 827 });
  expect(fixture.source['js/translations.js'].dictionaryLines).toEqual({
    en: { start: 3, end: 1029 },
    'zh-CN': { start: 1030, end: 2012 },
  });
  const serialized = JSON.stringify(fixture);
  for (const locale of fixture.excludedLocales) {
    expect(serialized).not.toContain('"' + locale + '":');
  }
  expect(JSON.stringify(fixture.keys[0] ?? {})).not.toContain('zh-TW');
});

it('resolves every twin.html data-i18n* key in both locales with non-empty bytes', () => {
  const attributes = [
    'data-i18n',
    'data-i18n-html',
    'data-i18n-title',
    'data-i18n-aria-label',
    'data-i18n-placeholder',
    'data-i18n-lbl',
  ];
  expect(fixture.attributeNames).toEqual(attributes);
  expect(fixture.attributeCounts).toEqual({
    'data-i18n': 105,
    'data-i18n-html': 0,
    'data-i18n-title': 26,
    'data-i18n-aria-label': 0,
    'data-i18n-placeholder': 2,
    'data-i18n-lbl': 0,
  });
  expect(Object.values(fixture.attributeCounts).reduce((total, count) => total + count, 0)).toBe(133);
  expect(fixture.counts.attributeRefs).toBe(133);
  expect(fixture.counts.uniqueAttributeKeys).toBe(133);
  expect(fixture.counts.missingDictionaryKeys).toBe(1);
  expect(fixture.keys).toHaveLength(132);
  expect(fixture.keys.length + fixture.counts.missingDictionaryKeys).toBe(fixture.counts.uniqueAttributeKeys);
  expect(new Set(fixture.keys.map((entry) => entry.key)).size).toBe(fixture.keys.length);
  for (const entry of fixture.keys) {
    expect(Object.keys(entry).sort()).toEqual(['attributes', 'en', 'key', 'zhCN']);
    expect(entry.key).toMatch(/^[a-z0-9_]+$/);
    expect(typeof entry.en).toBe('string');
    expect(entry.en.length).toBeGreaterThan(0);
    expect(typeof entry.zhCN).toBe('string');
    expect(entry.zhCN.length).toBeGreaterThan(0);
    expect(entry.attributes.length).toBeGreaterThan(0);
    for (const attribute of entry.attributes) expect(attributes).toContain(attribute);
  }
  expect(fixture.keys.some((entry) => entry.key === 'nav_lang_toggle')).toBe(false);
  expect(fixture.keys.find((entry) => entry.key === 'site_title')?.en).toContain('Digital Twin Platform');
});

it('records the real dictionary gap and the Chinese-only toasts explicitly', () => {
  expect(fixture.missingKinds).toEqual({
    'dictionary-key': 'twin.html reference missing from the frozen en or zh-CN dictionary',
    'zh-only-copy': 'frozen Chinese-only UI copy with no en variant',
  });
  expect(fixture.counts.missing).toBe(fixture.missing.length);
  expect(fixture.missing).toHaveLength(6);
  for (const entry of fixture.missing) {
    expect(Object.keys(fixture.missingKinds)).toContain(entry.kind);
    expect(entry.reason.length).toBeGreaterThan(0);
  }
  const dictionaryGaps = fixture.missing.filter((entry) => entry.kind === 'dictionary-key');
  expect(dictionaryGaps).toHaveLength(1);
  const [dictionaryGap] = dictionaryGaps;
  expect(dictionaryGap.key).toBe('nav_lang_toggle');
  expect(dictionaryGap.attributes).toEqual(['data-i18n-title']);
  expect(dictionaryGap.sourceLines).toEqual([1804]);
  expect(dictionaryGap.locales).toEqual(['en', 'zh-CN']);
  const copyGaps = fixture.missing.filter((entry) => entry.kind === 'zh-only-copy');
  expect(copyGaps.map((entry) => entry.sourceLine)).toEqual([14812, 14826, 14879, 14911, 14981]);
  for (const entry of copyGaps) {
    expect(entry.surface).toBe('twin-toast');
    expect(entry.en).toBeNull();
    expect(CJK.test(entry.zhCN) || entry.zhCN.includes(PLACEHOLDER)).toBe(true);
  }
});

it('extracts dynamic zh/en pairs covering patrol, AMHS, wafer, tour and scenario copy', () => {
  expect(fixture.counts.dynamic).toBe(fixture.dynamic.length);
  expect(fixture.dynamic).toHaveLength(176);
  expect(new Set(fixture.dynamic.map((entry) => entry.id)).size).toBe(fixture.dynamic.length);
  const inlineScript = fixture.source['twin.html'].inlineScript;
  expect(inlineScript?.start).toBeGreaterThan(0);
  expect(inlineScript?.end).toBeGreaterThanOrEqual(inlineScript?.start ?? 0);
  const categories = new Set<string>();
  for (const entry of fixture.dynamic) {
    expect(Object.keys(entry).sort()).toEqual(['en', 'id', 'sourceLine', 'zhCN']);
    expect(entry.id).toMatch(/^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)*\.\d+$/);
    expect(typeof entry.en).toBe('string');
    expect(entry.en.length).toBeGreaterThan(0);
    expect(typeof entry.zhCN).toBe('string');
    expect(entry.zhCN.length).toBeGreaterThan(0);
    expect(CJK.test(entry.zhCN) || entry.zhCN.includes(PLACEHOLDER)).toBe(true);
    expect(placeholderCount(entry.zhCN)).toBe(placeholderCount(entry.en));
    expect(Number.isInteger(entry.sourceLine)).toBe(true);
    expect(entry.sourceLine).toBeGreaterThanOrEqual(inlineScript?.start ?? 0);
    expect(entry.sourceLine).toBeLessThanOrEqual(inlineScript?.end ?? 0);
    categories.add(entry.id.slice(0, entry.id.indexOf('.')));
  }
  for (const category of ['patrol', 'amhs', 'wafer', 'tour']) expect(categories.has(category)).toBe(true);

  const patrolStatus = dynamicIn('patrol.status-text').sort(bySourceLine);
  expect(patrolStatus.map((entry) => entry.sourceLine)).toEqual([9103, 9617, 9630, 9647, 9730, 9771, 9803, 9811]);
  expect(patrolStatus[3]?.zhCN).toContain('吹淋');
  expect(patrolStatus[3]?.zhCN).toContain('28 m/s');
  expect(placeholderCount(patrolStatus[3]?.zhCN ?? '')).toBe(1);
  expect(patrolStatus[7]?.en).toContain('Litho Patrol Completed');
  expect(dynamicIn('patrol.name')).toHaveLength(4);
  const airShowerBillboard = dynamicIn('patrol.draw-air-shower-billboard-canvas');
  expect(airShowerBillboard).toHaveLength(4);
  expect(airShowerBillboard.map((entry) => entry.en)).toContain('LITHO AMBER AIRLOCK');
  expect(airShowerBillboard.map((entry) => entry.en)).toContain('MAIN AIR SHOWER TUNNEL');

  const amhs = dynamicIn('amhs');
  expect(amhs).toHaveLength(20);
  expect(dynamicIn('amhs.bay-name')).toHaveLength(14);
  const amhsEn = amhs.map((entry) => entry.en);
  for (const text of ['AMHS Simulated', 'Jobs', 'Avg', 'Active', 'Utilization Heatmap']) {
    expect(amhsEn).toContain(text);
  }

  const wafer = dynamicIn('wafer');
  expect(wafer).toHaveLength(5);
  expect(wafer.map((entry) => entry.en)).toEqual(['Route complete', 'Navigating...', 'Paused', 'Follow Cam', 'Free Cam']);

  const tour = dynamicIn('tour');
  expect(tour).toHaveLength(23);
  expect(dynamicIn('tour.title')).toHaveLength(8);
  expect(dynamicIn('tour.desc')).toHaveLength(8);
  expect(dynamicIn('tour.tag')).toHaveLength(3);
  expect(dynamicIn('tour.tag').map((entry) => entry.en)).toEqual(['STEP 1 OF 3', 'STEP 2 OF 3', 'STEP 3 OF 3']);
  expect(tour.map((entry) => entry.en)).toContain('Got it / Explore');
  expect(tour.map((entry) => entry.zhCN)).toContain('第 1 / 3 步');

  const scenarios = dynamicIn('scenario.update-scenario-select-options');
  expect(scenarios.map((entry) => entry.en)).toEqual([
    '🟢 Baseline (93.4%)',
    '🟡 Overlay Drift',
    '🔴 Etch RF Down',
    '🔵 Scheduled PM',
    '⚡ Cascade Fail',
    '🚀 AI-APC (96.5%)',
  ]);
  const toastPairs = dynamicIn('toast.load-catalog-and-build-layout');
  expect(toastPairs).toHaveLength(1);
  expect(toastPairs[0]?.en).toBe('Custom layout validation failed, using default layout');
});

it('keeps the parser limitations in an explicitly typed skipped list', () => {
  expect(fixture.counts.skipped).toBe(fixture.skipped.length);
  expect(fixture.skipped).toHaveLength(16);
  const skippedKinds = Object.keys(fixture.skippedKinds);
  const inlineScript = fixture.source['twin.html'].inlineScript;
  for (const entry of fixture.skipped) {
    expect(skippedKinds).toContain(entry.kind);
    expect(entry.reason.length).toBeGreaterThan(0);
    expect(entry.sourceLine).toBeGreaterThanOrEqual(inlineScript?.start ?? 0);
    expect(entry.sourceLine).toBeLessThanOrEqual(inlineScript?.end ?? 0);
  }
  const kinds = new Set(fixture.skipped.map((entry) => entry.kind));
  for (const kind of ['font-metric-ternary', 'expression-branch', 'nested-ternary', 'non-literal-branch']) {
    expect(kinds.has(kind)).toBe(true);
  }
  expect(fixture.skipped.filter((entry) => entry.kind === 'font-metric-ternary').map((entry) => entry.sourceLine)).toEqual([9999, 10007]);
  expect(fixture.skipped.find((entry) => entry.sourceLine === 18364)?.kind).toBe('expression-branch');
  expect(fixture.skipped.find((entry) => entry.sourceLine === 21253)?.kind).toBe('nested-ternary');
});

it('keeps fixture counts, ordering and top-level schema self-consistent', () => {
  expect(fixture.generatedBy).toBe('tools/build_twin_i18n_vectors.cjs');
  expect(Object.keys(fixture)).toEqual([
    'generatedBy',
    'source',
    'locales',
    'excludedLocales',
    'frozenLocaleIds',
    'dictionaryKeyCounts',
    'attributeNames',
    'attributeCounts',
    'missingKinds',
    'skippedKinds',
    'counts',
    'rules',
    'keys',
    'dynamic',
    'missing',
    'skipped',
  ]);
  expect(Object.keys(fixture.rules)).toEqual([
    'dictionary',
    'static',
    'namedPair',
    'ternary',
    'groupedArray',
    'zhOnlyCopy',
    'skipped',
  ]);
  expect(fixture.counts).toEqual({
    keys: 132,
    attributeRefs: 133,
    uniqueAttributeKeys: 133,
    missingDictionaryKeys: 1,
    dynamic: 176,
    missing: 6,
    skipped: 16,
  });
  expect(fixture.counts.keys).toBe(fixture.keys.length);
  expect(fixture.counts.dynamic).toBe(fixture.dynamic.length);
  const arrays: { sourceLine: number }[][] = [fixture.dynamic, fixture.missing, fixture.skipped];
  for (const entries of arrays) {
    const sorted = [...entries].sort(bySourceLine);
    expect(entries.map((entry) => entry.sourceLine)).toEqual(sorted.map((entry) => entry.sourceLine));
  }
});
