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

/** Top-level feature owners importing a shared component module (module path suffix). */
function featureImporters(moduleSuffix: string): string[] {
  const owners = new Set<string>();
  for (const file of files) {
    const path = relativeToSource(file);
    const feature = /^(catalog|twin|workbench)\//.exec(path)?.[1];
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
  expect(featureImporters('components/modal')).toEqual(['catalog', 'twin']);
});

it('keeps the shared design system real: no feature-local component forwarding', () => {
  const componentFiles = readdirSync(join(sourceRoot, 'components')).sort();
  expect(componentFiles).toEqual([
    'class-names.ts',
    'error-boundary.tsx',
    'modal.tsx',
    'original-icons-data.ts',
    'original-icons.tsx',
  ]);
  for (const removed of ['widgets.tsx', 'charting.tsx', 'ui.tsx']) {
    expect(componentFiles).not.toContain(removed);
  }

  const definitions = files
    .filter((file) => /export function (Metric|CompletionBar|Panel|StatusPill)\b/.test(readFileSync(file, 'utf8')))
    .map(relativeToSource)
    .sort();
  expect(definitions).toEqual([
    'workbench/completion-bar.tsx',
    'workbench/metric.tsx',
    'workbench/panel.tsx',
    'workbench/status-pill.tsx',
  ]);

  const classNamesOwners = new Set(
    files
      .filter((file) => importsOf(file).some((specifier) => specifier.endsWith('components/class-names')))
      .map((file) => relativeToSource(file).split('/')[0]),
  );
  expect(classNamesOwners).toEqual(new Set(['twin', 'workbench']));

  expect(featureImporters('components/original-icons')).toEqual(['twin']);
});

it('keeps the Workbench command/data ownership split explicit', () => {
  const workbench = readFileSync(join(sourceRoot, 'workbench/workbench.tsx'), 'utf8');
  expect(workbench).toContain("@/workbench/use-run-submission");
  expect(workbench).toContain("@/workbench/run-form");
  expect(workbench).toContain("@/workbench/fab-overview");
  expect(workbench).toContain("@/workbench/run-history");
  expect(workbench).toContain("@/workbench/workbench-metrics");
  const store = readFileSync(join(sourceRoot, 'workbench/workbench.atom.ts'), 'utf8');
  expect(store).not.toMatch(/pendingSubmission|submissionPrepared|submissionCompleted/);
  expect(store).not.toMatch(/RunSummary|RunResult|CommandWorkflowProjection/);
  const consoleView = readFileSync(join(sourceRoot, 'workbench/command-console.tsx'), 'utf8');
  expect(consoleView).toContain('useCommandProjection');
  expect(consoleView).not.toMatch(/useState|useRef/);
});
