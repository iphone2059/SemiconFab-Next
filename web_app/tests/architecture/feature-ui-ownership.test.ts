import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

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

function importsOf(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  return [...text.matchAll(/(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g)].map((match) => match[1]);
}

const files = sourceFiles(sourceRoot);
const relativeToSource = (file: string): string => relative(sourceRoot, file).replaceAll('\\', '/');

/** Feature owners importing a shared component module (module path suffix). */
function featureImporters(moduleSuffix: string): string[] {
  const owners = new Set<string>();
  for (const file of files) {
    const path = relativeToSource(file);
    const feature = /^features\/([^/]+)\//.exec(path)?.[1];
    if (!feature) continue;
    if (importsOf(file).some((specifier) => specifier.replaceAll('\\', '/').endsWith(moduleSuffix))) {
      owners.add(feature);
    }
  }
  return [...owners].sort();
}

it('keeps components/modal.tsx as the single native Dialog implementation', () => {
  const dialogImplementations = files
    .filter((file) => /<dialog\b|createElement\(\s*['"]dialog['"]/.test(readFileSync(file, 'utf8')))
    .map(relativeToSource);
  expect(dialogImplementations, 'features must compose components/modal.tsx, never copy a Dialog').toEqual([
    'components/modal.tsx',
  ]);

  // The one Dialog is genuinely cross-feature: the catalog detail view and the
  // Twin dialogs both compose it (R12), so it is not a feature-local widget.
  expect(featureImporters('components/modal')).toEqual(['catalog', 'twin']);
});

it('keeps the shared design system real: no feature-local component forwarding', () => {
  // The Workbench-only pieces live in their feature; the global forwarding files
  // are deleted rather than re-exported.
  const componentFiles = readdirSync(join(sourceRoot, 'components')).sort();
  expect(componentFiles).toEqual([
    'class-names.ts',
    'error-boundary.tsx',
    'modal.tsx',
    'original-icons-data.ts',
    'original-icons.tsx',
    'ui.tsx',
  ]);
  for (const removed of ['widgets.tsx', 'charting.tsx']) {
    expect(componentFiles).not.toContain(removed);
  }

  const definitions = files
    .filter((file) => /export function (Metric|CompletionBar)\b/.test(readFileSync(file, 'utf8')))
    .map(relativeToSource)
    .sort();
  expect(definitions).toEqual([
    'features/workbench/components/completion-bar.tsx',
    'features/workbench/components/metric.tsx',
  ]);

  // class-names is shared by the design-system primitives and the Twin feature.
  const ownerOf = (path: string): string =>
    path.startsWith('features/') ? path.split('/').slice(0, 2).join('/') : path.split('/')[0];
  const classNamesOwners = new Set(
    files
      .filter((file) => importsOf(file).some((specifier) => specifier.endsWith('components/class-names') || specifier === './class-names'))
      .map((file) => ownerOf(relativeToSource(file))),
  );
  expect(classNamesOwners).toEqual(new Set(['components', 'features/twin']));

  // original-icons is the frozen inventory captured from the original twin page;
  // it is the only global icon source and the Twin feature consumes it.
  expect(featureImporters('components/original-icons')).toEqual(['twin']);
});

it('keeps the Workbench command/data ownership split explicit', () => {
  const workbench = readFileSync(join(sourceRoot, 'features/workbench/workbench.tsx'), 'utf8');
  // The page is a composition root; the submission lifecycle and views are local.
  expect(workbench).toContain('./controllers/use-run-submission');
  expect(workbench).toContain('./components/run-form');
  expect(workbench).toContain('./components/fab-overview');
  expect(workbench).toContain('./components/run-history');
  expect(workbench).toContain('./components/workbench-metrics');
  // No Query payload may be copied into the client store: the store module must
  // not mention run/result payload fields or command projections.
  const store = readFileSync(join(sourceRoot, 'features/workbench/state/workbenchStore.ts'), 'utf8');
  expect(store).not.toMatch(/pendingSubmission|submissionPrepared|submissionCompleted/);
  expect(store).not.toMatch(/RunSummary|RunResult|CommandWorkflowProjection/);
  const consoleView = readFileSync(join(sourceRoot, 'features/workbench/command-console.tsx'), 'utf8');
  // The console reads projections from the runtime hook only; it never stores one.
  expect(consoleView).toContain('useCommandProjection');
  expect(consoleView).not.toMatch(/useState|useRef/);
});
