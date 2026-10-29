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

const files = (directory?: string) => (directory ? sourceFiles(join(sourceRoot, directory)) : sourceFiles(sourceRoot));
const relativeToSource = (file: string): string => relative(sourceRoot, file).replaceAll('\\', '/');

it('ARCH-06: realtime never imports runtime command implementations, XState or React state libraries', () => {
  for (const file of files('realtime')) {
    const path = relativeToSource(file);
    for (const specifier of importsOf(file)) {
      expect(specifier, path).not.toMatch(/(^|\/)runtime(\/|$)/);
      expect(specifier, path).not.toMatch(/xstate/);
      expect(specifier, path).not.toMatch(/^(react|@tanstack|zustand)/);
      expect(specifier, path).not.toMatch(/@\/runtime(\/|$)/);
    }
  }
});

it('ARCH-07: XState stays confined to the runtime machine/adapter boundary', () => {
  const allowed = new Set(['runtime/equipment-command.machine.ts', 'runtime/xstate-command-workflow-adapter.ts']);
  const violations: string[] = [];
  for (const file of files()) {
    const path = relativeToSource(file);
    if (importsOf(file).some((specifier) => /^xstate($|\/)/.test(specifier)) && !allowed.has(path)) {
      violations.push(path + ' imports xstate outside the command workflow boundary');
    }
  }
  expect(violations).toEqual([]);
});

it('ARCH-11: high-frequency buffers/workers and rendering do not import state containers', () => {
  const highFrequency = (path: string): boolean =>
    path.startsWith('rendering/') || /^realtime\/(telemetry\.worker|telemetry-worker\.logic|frame-ring-buffer|message-decoder)/.test(path);
  for (const file of files()) {
    const path = relativeToSource(file);
    if (!highFrequency(path)) continue;
    for (const specifier of importsOf(file)) {
      expect(specifier, path).not.toMatch(/^(react|react-dom|@tanstack|zustand|xstate)$/);
      expect(specifier, path).not.toMatch(/@\/state(\/|$)/);
    }
  }
});

it('M5b: the legacy src/render directory is gone and rendering is flat', () => {
  expect(() => statSync(join(sourceRoot, 'render'))).toThrow();
  expect(statSync(join(sourceRoot, 'rendering', 'lite-backend.ts')).isFile()).toBe(true);
  expect(() => statSync(join(sourceRoot, 'rendering', 'lite'))).toThrow();
});

it('M5c: page modules live in top-level feature directories and shared UI under components/', () => {
  for (const directory of ['twin', 'catalog', 'workbench']) {
    expect(statSync(join(sourceRoot, directory)).isDirectory(), directory).toBe(true);
  }
  for (const file of ['modal.tsx', 'error-boundary.tsx', 'class-names.ts', 'original-icons.tsx']) {
    expect(statSync(join(sourceRoot, 'components', file)).isFile()).toBe(true);
  }
  for (const file of ['widgets.tsx', 'charting.tsx', 'ui.tsx']) {
    expect(() => statSync(join(sourceRoot, 'components', file)), file).toThrow();
  }
  for (const file of ['metric.tsx', 'completion-bar.tsx', 'panel.tsx', 'status-pill.tsx']) {
    expect(statSync(join(sourceRoot, 'workbench', file)).isFile(), file).toBe(true);
  }
  for (const legacy of ['twin-page.tsx', 'catalog-page.tsx', 'workbench.tsx', 'ui.tsx']) {
    expect(() => statSync(join(sourceRoot, legacy)), legacy).toThrow();
  }
});

it('ARCH-08: the public CommandWorkflow contract is defined only once', () => {
  const declarations = files('contracts').filter((file) =>
    readFileSync(file, 'utf8').includes('export interface CommandWorkflow '),
  );
  expect(declarations.map(relativeToSource)).toEqual(['contracts/command-workflow.contract.ts']);
});
