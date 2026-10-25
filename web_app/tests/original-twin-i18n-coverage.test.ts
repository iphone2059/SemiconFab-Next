import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  GENERATED_TWIN_COLLISIONS,
  GENERATED_TWIN_EN,
  GENERATED_TWIN_PROVENANCE,
} from '../src/twin-translations.generated';
import { TWIN_EN } from '../src/twin-translations';

type FixtureKey = { key: string; en: string; zhCN: string };
type FixtureDynamic = { id: string; zhCN: string; en: string };
type Fixture = {
  source: Record<string, { sha256: string; bytes: number; lines: number }>;
  locales: string[];
  excludedLocales: string[];
  dictionaryKeyCounts: Record<string, number>;
  counts: Record<string, number>;
  keys: FixtureKey[];
  dynamic: FixtureDynamic[];
};
type Totals = {
  literalPairs: number;
  twinUiPairs: number;
  otherUiPairs: number;
  explicitPairs: number;
  oneArgPairs: number;
  parameterizedPairs: number;
  frozenMappedPairs: number;
  twinEnOnlyPairs: number;
  absentFromBothMaps: number;
  matchedFrozen: number;
  frozenContradictions: number;
  allowlistedContradictions: number;
  unallowlistedContradictions: number;
  absentExplicitPairs: number;
  emptyEnglishArguments: number;
  nonStringEnglishArguments: number;
  nonLiteralFirstArgumentCalls: number;
};
type FileStats = Totals & { path: string; surface: string };
type Located = { file: string; line: number; surface: string; zhCN: string };
type AbsentFinding = Located & { explicitEn: string | null; kind: string };
type TwinEnOnlyFinding = Located & { explicitEn: string | null; twinEn: string };
type ContradictionFinding = Located & { explicitEn: string; frozenEn: string };
type MissingArgumentFinding = Located & { reason: string; argument: string };
type CoverageReport = {
  schemaVersion: number;
  generatedBy: string;
  generatorCommand: string;
  source: {
    fixture: string;
    fixtureSha256: string;
    module: string;
    twinTranslations: string;
    generatedMapEntries: number;
    generatedCollisions: number;
    twinEnEntries: number;
  };
  generated: {
    entries: { sourcePairs: number; uniqueZh: number; collapsedDuplicates: number; collisions: number };
    fixtureCounts: Record<string, number>;
    sourceSha256: Record<string, string>;
    fixtureSha256: string;
    collisionPolicy: string;
    collisionKeys: string[];
  };
  scope: {
    scanRoot: string;
    fileExtensions: string[];
    excluded: string[];
    twinUiRule: string;
    callRule: string;
    scannedFiles: string[];
    twinUiFiles: string[];
  };
  totals: Totals;
  surfaces: Record<string, Totals>;
  files: FileStats[];
  allowlistPolicy: string;
  allowlist: { zhCN: string; explicitEn: string; justification: string }[];
  findings: {
    absentFromBothMaps: AbsentFinding[];
    twinEnOnly: TwinEnOnlyFinding[];
    frozenContradictions: ContradictionFinding[];
    allowlistedContradictions: (ContradictionFinding & { justification: string })[];
    missingEnglishArguments: MissingArgumentFinding[];
    staleAllowlist: { zhCN: string; explicitEn: string; justification: string }[];
  };
  checks: { ok: boolean; hardFailures: string[] };
};

const readJson = (url: URL) => JSON.parse(readFileSync(url, 'utf8'));
const readText = (url: URL) => readFileSync(url, 'utf8');
const fixture = readJson(new URL('../assets/original-twin-i18n.json', import.meta.url)) as Fixture;
const coverage = readJson(new URL('../assets/twin-i18n-coverage.json', import.meta.url)) as CoverageReport;

const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

function expectedGeneratedMap(): { map: Record<string, string>; collisions: Record<string, string[]> } {
  const sourcePairs: { zhCN: string; en: string }[] = [];
  for (const key of fixture.keys) if (key.zhCN && key.en) sourcePairs.push({ zhCN: key.zhCN, en: key.en });
  for (const pair of fixture.dynamic) if (pair.zhCN && pair.en) sourcePairs.push({ zhCN: pair.zhCN, en: pair.en });
  const groups = new Map<string, string[]>();
  for (const pair of sourcePairs) {
    if (!groups.has(pair.zhCN)) groups.set(pair.zhCN, []);
    groups.get(pair.zhCN)?.push(pair.en);
  }
  const map: Record<string, string> = {};
  const collisions: Record<string, string[]> = {};
  for (const zhCN of [...groups.keys()].sort(compareText)) {
    const distinct: string[] = [];
    for (const en of groups.get(zhCN) ?? []) if (!distinct.includes(en)) distinct.push(en);
    map[zhCN] = distinct[0];
    if (distinct.length > 1) collisions[zhCN] = distinct;
  }
  return { map, collisions };
}

it('consumes the declared frozen fixture provenance and counts', () => {
  const fixtureText = readText(new URL('../assets/original-twin-i18n.json', import.meta.url));
  const fixtureSha256 = sha256(fixtureText);
  expect(coverage.source.fixture).toBe('web_app/assets/original-twin-i18n.json');
  expect(coverage.source.fixtureSha256).toBe(fixtureSha256);
  expect(GENERATED_TWIN_PROVENANCE.fixtureSha256).toBe(fixtureSha256);
  expect(coverage.generated.fixtureSha256).toBe(fixtureSha256);
  expect(coverage.generated.fixtureCounts).toEqual(fixture.counts);
  expect(GENERATED_TWIN_PROVENANCE.fixtureCounts).toEqual(fixture.counts);
  expect(coverage.generated.sourceSha256).toEqual(GENERATED_TWIN_PROVENANCE.sourceSha256);
  for (const file of ['twin.html', 'js/translations.js', 'js/i18n.js']) {
    expect(coverage.generated.sourceSha256[file]).toBe(fixture.source[file]?.sha256);
  }
  expect(coverage.generated.entries.sourcePairs).toBe(fixture.counts.keys + fixture.counts.dynamic);
  expect(coverage.source.generatedMapEntries).toBe(Object.keys(GENERATED_TWIN_EN).length);
  expect(coverage.source.twinEnEntries).toBe(Object.keys(TWIN_EN).length);
  expect(coverage.totals.nonLiteralFirstArgumentCalls).toBe(11);
  expect(coverage.files.length).toBeGreaterThan(0);
});

it('keeps the generated map deterministic and free of non en/zh-CN bytes', () => {
  const expected = expectedGeneratedMap();
  expect(GENERATED_TWIN_EN).toEqual(expected.map);
  expect(GENERATED_TWIN_COLLISIONS).toEqual(expected.collisions);
  expect(GENERATED_TWIN_PROVENANCE.entries.uniqueZh).toBe(Object.keys(GENERATED_TWIN_EN).length);
  expect(GENERATED_TWIN_PROVENANCE.entries.sourcePairs).toBe(fixture.counts.keys + fixture.counts.dynamic);
  expect(GENERATED_TWIN_PROVENANCE.entries.collisions).toBe(Object.keys(GENERATED_TWIN_COLLISIONS).length);
  const keys = Object.keys(GENERATED_TWIN_EN);
  expect(keys).toEqual([...keys].sort(compareText));
  for (const zhCN of keys) {
    expect(zhCN.length).toBeGreaterThan(0);
    expect((GENERATED_TWIN_EN[zhCN] ?? '').length).toBeGreaterThan(0);
  }
  expect(keys.length).toBeGreaterThanOrEqual(fixture.counts.keys);
  expect(keys.length).toBeGreaterThanOrEqual(fixture.counts.dynamic);
  expect([...GENERATED_TWIN_PROVENANCE.locales]).toEqual(['en', 'zh-CN']);
  expect([...GENERATED_TWIN_PROVENANCE.excludedLocales]).toEqual(fixture.excludedLocales);
  const generatedText = readText(new URL('../src/twin-translations.generated.ts', import.meta.url));
  for (const locale of fixture.excludedLocales) expect(generatedText).not.toContain('"' + locale + '":');
});

it('reports same-zh/different-en collisions instead of silently dropping them', () => {
  const expected = expectedGeneratedMap();
  expect(Object.keys(GENERATED_TWIN_COLLISIONS)).toHaveLength(9);
  expect(Object.keys(GENERATED_TWIN_COLLISIONS)).toEqual(Object.keys(expected.collisions));
  for (const zhCN of Object.keys(GENERATED_TWIN_COLLISIONS)) {
    const values = GENERATED_TWIN_COLLISIONS[zhCN] ?? [];
    expect(values.length).toBeGreaterThan(1);
    expect(new Set(values).size).toBe(values.length);
    expect(GENERATED_TWIN_EN[zhCN]).toBe(values[0]);
  }
  expect(coverage.generated.collisionKeys).toEqual(Object.keys(GENERATED_TWIN_COLLISIONS).sort(compareText));
  expect(coverage.source.generatedCollisions).toBe(Object.keys(GENERATED_TWIN_COLLISIONS).length);
  expect(coverage.generated.entries.collapsedDuplicates).toBe(27);
});

it('keeps the coverage audit totals self-consistent with no empty English arguments', () => {
  const { totals, findings } = coverage;
  expect(totals.literalPairs).toBe(178);
  expect(totals.explicitPairs).toBe(41);
  expect(totals.frozenMappedPairs).toBe(20);
  expect(totals.twinEnOnlyPairs).toBe(117);
  expect(totals.absentFromBothMaps).toBe(41);
  expect(totals.twinUiPairs).toBe(137);
  expect(totals.otherUiPairs).toBe(41);
  expect(totals.matchedFrozen).toBe(0);
  expect(totals.frozenContradictions).toBe(0);
  expect(totals.frozenMappedPairs + totals.twinEnOnlyPairs + totals.absentFromBothMaps).toBe(totals.literalPairs);
  expect(totals.explicitPairs + totals.oneArgPairs + totals.parameterizedPairs).toBe(totals.literalPairs);
  expect(totals.twinUiPairs + totals.otherUiPairs).toBe(totals.literalPairs);
  expect(totals.matchedFrozen + totals.frozenContradictions + totals.absentExplicitPairs).toBe(totals.explicitPairs);
  expect(totals.frozenContradictions).toBe(totals.allowlistedContradictions + totals.unallowlistedContradictions);
  expect(totals.emptyEnglishArguments).toBe(0);
  expect(totals.nonStringEnglishArguments).toBe(0);
  expect(findings.absentFromBothMaps).toHaveLength(totals.absentFromBothMaps);
  expect(findings.twinEnOnly).toHaveLength(totals.twinEnOnlyPairs);
  expect(findings.frozenContradictions).toHaveLength(totals.unallowlistedContradictions);
  expect(findings.allowlistedContradictions).toHaveLength(totals.allowlistedContradictions);
  expect(findings.missingEnglishArguments).toHaveLength(totals.emptyEnglishArguments + totals.nonStringEnglishArguments);
  expect(findings.staleAllowlist).toHaveLength(0);
  expect(coverage.checks.ok).toBe(true);
  expect(coverage.checks.hardFailures).toEqual([]);
  const explicitAbsent = findings.absentFromBothMaps.filter((entry) => entry.explicitEn !== null).length +
    findings.twinEnOnly.filter((entry) => entry.explicitEn !== null).length;
  expect(explicitAbsent).toBe(totals.absentExplicitPairs);
  expect(coverage.files.reduce((total, file) => total + file.literalPairs, 0)).toBe(totals.literalPairs);
  for (const surface of ['twin-ui', 'other-ui']) {
    const stats = coverage.surfaces[surface];
    const rows = coverage.files.filter((file) => file.surface === surface);
    expect(stats?.literalPairs).toBe(rows.reduce((total, file) => total + file.literalPairs, 0));
  }
  for (const file of coverage.files) {
    expect(coverage.scope.scannedFiles).toContain(file.path);
    expect(file.surface === 'twin-ui' || file.surface === 'other-ui').toBe(true);
  }
});

it('covers the twin UI surface and records the actionable C2 findings', () => {
  for (const file of [
    'web_app/src/twin-page.tsx',
    'web_app/src/twin-sidebar.tsx',
    'web_app/src/twin-inspector.tsx',
    'web_app/src/twin-dialogs.tsx',
    'web_app/src/fab-viewer.tsx',
  ]) {
    expect(coverage.scope.twinUiFiles).toContain(file);
  }
  expect(coverage.scope.scannedFiles.length).toBeGreaterThan(60);
  for (const file of coverage.scope.scannedFiles) {
    expect(file.startsWith('web_app/src/')).toBe(true);
    expect(file.endsWith('.d.ts')).toBe(false);
  }
  const twinAbsent = coverage.findings.absentFromBothMaps
    .filter((entry) => entry.surface === 'twin-ui')
    .map((entry) => entry.zhCN)
    .sort(compareText);
  expect(twinAbsent).toEqual(['关闭', '尺寸']);
  expect(coverage.findings.absentFromBothMaps.every((entry) => entry.line > 0 && entry.file.length > 0)).toBe(true);
  expect(coverage.allowlistPolicy.length).toBeGreaterThan(100);
  expect(coverage.allowlist).toEqual([]);
  for (const entry of coverage.allowlist) expect(entry.justification.trim().length).toBeGreaterThan(0);
});
