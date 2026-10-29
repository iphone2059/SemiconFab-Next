import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

/**
 * G13 / INV-11: atom ownership and notification-surface gate.
 *
 * The former `state/runtime-store.ts` and `twin/twin-page.atom.ts` were single
 * keepAlive objects mixing unrelated owners. This file freezes the structural
 * result: one owner per atom module, no Store-named state module, bounded object
 * shapes, and the EquipmentStatusPipeline contract kept on the FAB-scoped atom.
 */
const sourceRoot = fileURLToPath(new URL('../../src/', import.meta.url));

function sourceFiles(directory: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory)) {
    const absolute = join(directory, entry);
    if (statSync(absolute).isDirectory()) out.push(...sourceFiles(absolute));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(absolute);
  }
  return out;
}

const files = sourceFiles(sourceRoot);
const relativeToSource = (file: string): string => relative(sourceRoot, file).replaceAll('\\', '/');
const sourceByPath = new Map(files.map((file): [string, string] => [relativeToSource(file), readFileSync(file, 'utf8')]));
const read = (path: string): string => {
  const value = sourceByPath.get(path);
  if (value === undefined) throw new Error('missing source file ' + path);
  return value;
};

function interfaceFields(source: string, interfaceName: string): string[] {
  const start = source.indexOf('export interface ' + interfaceName + ' {');
  if (start < 0) throw new Error('missing interface ' + interfaceName);
  const end = source.indexOf('\n}', start);
  if (end < 0) throw new Error('unterminated interface ' + interfaceName);
  return [...source.slice(start, end).matchAll(/^ {2}(\w+)\??:/gm)].map((match) => match[1]);
}

function typeAliasFields(source: string, typeName: string): string[] {
  const start = source.indexOf('export type ' + typeName + ' = {');
  if (start < 0) throw new Error('missing type alias ' + typeName);
  const end = source.indexOf('\n}', start);
  if (end < 0) throw new Error('unterminated type alias ' + typeName);
  return [...source.slice(start, end).matchAll(/^ {2}(\w+)\??:/gm)].map((match) => match[1]);
}

function actionNames(source: string, actionsName: string): string[] {
  const start = source.indexOf('export const ' + actionsName + ' = {');
  if (start < 0) throw new Error('missing actions ' + actionsName);
  const end = source.indexOf('\n};', start);
  if (end < 0) throw new Error('unterminated actions ' + actionsName);
  return [...source.slice(start, end).matchAll(/^ {2}(\w+): /gm)].map((match) => match[1]);
}

it('removes the legacy runtime store and splits viewer lifecycle from application runtime state', () => {
  expect(sourceByPath.has('state/runtime-store.ts')).toBe(false);
  // No production import may reference the deleted module path.
  expect([...sourceByPath].filter(([, text]) => /from '@\/state\/runtime-store'/.test(text))).toEqual([]);

  // Application-level state carries only application data; viewer lifecycle is not mixed in.
  expect(interfaceFields(read('state/runtime.atom.ts'), 'RuntimeState')).toEqual(['fatalError']);
  expect(read('state/runtime.atom.ts')).not.toMatch(/export (?:interface|type|const) \w*[Vv]iewer/);
  expect(read('state/runtime.atom.ts')).not.toMatch(/viewer:s/);
  // The rendering-scope atoms are split by update frequency and contain no app-level error branch.
  const viewer = read('state/viewer.atom.ts');
  expect(interfaceFields(viewer, 'ViewerSession')).toEqual(['epoch', 'generation', 'lifecycle', 'status']);
  expect(viewer).not.toMatch(/fatalError/);
  for (const atom of ['viewerSessionAtom', 'viewerHoverAtom', 'viewerSelectionSyncAtom']) {
    expect(viewer, atom).toContain('export const ' + atom);
  }
});

it('splits the Twin page atoms by owner and update frequency', () => {
  for (const module of [
    'twin/twin-page.atom.ts',
    'twin/twin-page-ui.atom.ts',
    'twin/twin-wafer.atom.ts',
    'twin/twin-yms.atom.ts',
    'twin/twin-amhs.atom.ts',
  ]) {
    expect(sourceByPath.has(module), module).toBe(true);
  }

  // FAB-scoped session projection: only server/FAB data, exactly the shape
  // EquipmentStatusPipeline feeds.
  expect(interfaceFields(read('twin/twin-page.atom.ts'), 'TwinFabState')).toEqual([
    'siteId', 'siteError', 'liveStatusScope', 'liveToolStates', 'replayBase', 'statusFeed', 'mesJobs', 'inspectorMes',
  ]);
  // Page UI overlays/preferences do not reach into FAB server state.
  expect(interfaceFields(read('twin/twin-page-ui.atom.ts'), 'TwinPageUiState')).toEqual([
    'selected', 'selection', 'layerPreferences', 'infoDialog', 'showResearchUtil', 'onboardingDontShow', 'sidebar', 'oemDialog', 'archQuery',
  ]);
  expect(typeAliasFields(read('twin/twin-wafer.atom.ts'), 'WaferUiState')).toEqual(['product', 'index', 'follow', 'hud', 'completed']);
  expect(typeAliasFields(read('twin/twin-yms.atom.ts'), 'YmsUiState')).toHaveLength(11);

  // Action namespaces are disjoint per owner.
  const fabActions = actionNames(read('twin/twin-page.atom.ts'), 'twinPageActions');
  expect(fabActions.sort()).toEqual([
    'inspectorMesSet', 'liveScopeActivated', 'liveSnapshotReceived', 'mesJobSet', 'replayBaseSet',
    'siteErrorSet', 'siteIdSet', 'statusFeedStale',
  ]);
  const uiActions = actionNames(read('twin/twin-page-ui.atom.ts'), 'twinPageUiActions');
  expect(uiActions).toEqual(expect.arrayContaining(['selectedSet', 'selectionSet', 'layerToggled', 'infoDialogSet', 'sidebarTabSet']));
  expect(uiActions.filter((name) => fabActions.includes(name))).toEqual([]);
  expect(actionNames(read('twin/twin-wafer.atom.ts'), 'twinWaferActions')).toEqual(['waferFrameReceived', 'waferFrameCleared', 'waferFollowSet']);
  expect(actionNames(read('twin/twin-amhs.atom.ts'), 'twinAmhsActions')).toEqual(['amhsSet']);
  expect(actionNames(read('twin/twin-yms.atom.ts'), 'twinYmsActions')).toEqual(expect.arrayContaining(['ymsOpenSet', 'ymsTabSet', 'ymsHoverDieSet']));

  // The pipeline's imported action surface is phase-frozen: those names stay on the FAB atom.
  for (const actionName of ['liveScopeActivated', 'liveSnapshotReceived', 'statusFeedStale']) {
    expect(fabActions).toContain(actionName);
  }
  // Overlay/playback/tool actions must never live on the FAB atom.
  for (const moved of ['selectedSet', 'layerToggled', 'sidebarTabSet', 'ymsOpenSet', 'waferFrameReceived', 'amhsSet']) {
    expect(fabActions).not.toContain(moved);
  }
});

it('keeps atom modules Store-free and every keepAlive object bounded', () => {
  const atomFiles = [...sourceByPath.keys()].filter((path) => /^(state|twin)\/.*\.atom\.(ts|tsx)$/.test(path));
  expect(atomFiles.length).toBeGreaterThanOrEqual(8);
  // G13: an Effect Atom implementation must not keep the legacy Store name in a module path.
  expect(atomFiles.filter((path) => /-store\./.test(path))).toEqual([]);
  const locale = read('state/locale.atom.ts');
  expect(locale).toContain('export interface LocaleState extends Preferences {}');
  expect(locale).not.toMatch(/StoreState|\bStore\b/);

  for (const path of atomFiles) {
    const source = read(path);
    for (const match of source.matchAll(/export interface (\w+) \{\n([\s\S]*?)\n\}/g)) {
      const fields = [...match[2].matchAll(/^ {2}(\w+)\??:/gm)].map((field) => field[1]);
      // Bounded object shapes: wide keepAlive objects recreate the notification problem.
      expect(fields.length, path + '#' + match[1] + ' fields: ' + fields.join(',')).toBeLessThanOrEqual(12);
    }
    // keepAlive is reserved for the owner atoms in *.atom.ts modules.
    if (source.includes('Atom.keepAlive')) expect(path).toMatch(/\.atom\.ts$/);
  }
});
