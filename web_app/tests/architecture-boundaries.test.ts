import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));

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

const files = (relativeDirectory: string) => sourceFiles(join(sourceRoot, relativeDirectory));

it('ARCH-06: realtime never imports runtime command implementations, XState or React state libraries', () => {
  for (const file of files('realtime')) {
    for (const specifier of importsOf(file)) {
      expect(specifier, relative(sourceRoot, file)).not.toMatch(/(^|\/)runtime\/commands(\/|$)/);
      expect(specifier, relative(sourceRoot, file)).not.toMatch(/xstate/);
      expect(specifier, relative(sourceRoot, file)).not.toMatch(/^(react|@tanstack|zustand)/);
      // Realtime depends on contracts only; coordination is application-layer.
      expect(specifier, relative(sourceRoot, file)).not.toMatch(/application\/coordination/);
    }
  }
});

it('ARCH-07: application coordination depends on contracts only (no realtime/React/Query/XState)', () => {
  for (const file of files('application')) {
    for (const specifier of importsOf(file)) {
      expect(specifier, relative(sourceRoot, file)).not.toMatch(/realtime(\/|$)/);
      expect(specifier, relative(sourceRoot, file)).not.toMatch(/runtime\/commands(\/|$)/);
      expect(specifier, relative(sourceRoot, file)).not.toMatch(/xstate/);
      expect(specifier, relative(sourceRoot, file)).not.toMatch(/^(react|@tanstack|zustand)/);
      const packageSpecifier = specifier.startsWith('.') ? '' : specifier;
      expect(packageSpecifier === '' || packageSpecifier === 'rxjs', relative(sourceRoot, file)).toBe(true);
    }
  }
});

it('ARCH-11: high-frequency buffers/workers and rendering do not import state containers', () => {
  for (const directory of ['realtime/buffers', 'realtime/workers', 'rendering']) {
    for (const file of files(directory)) {
      const path = relative(sourceRoot, file).replaceAll('\\', '/');
      for (const specifier of importsOf(file)) {
        expect(specifier, path).not.toMatch(/^(react|react-dom|@tanstack|zustand|xstate)$/);
        expect(specifier, path).not.toMatch(/state\//);
        expect(specifier, path).not.toMatch(/application\/(coordination|contracts)/);
      }
    }
  }
});

it('M5b: the legacy src/render directory is gone and rendering/lite exists', () => {
  expect(() => statSync(join(sourceRoot, 'render'))).toThrow();
  expect(statSync(join(sourceRoot, 'rendering', 'lite')).isDirectory()).toBe(true);
});

it('M5c: page modules live under features/ and shared UI under components/', () => {
  for (const directory of ['features/twin', 'features/catalog', 'features/workbench']) {
    expect(statSync(join(sourceRoot, directory)).isDirectory()).toBe(true);
  }
  for (const file of ['ui.tsx', 'widgets.tsx', 'charting.tsx', 'error-boundary.tsx']) {
    expect(statSync(join(sourceRoot, 'components', file)).isFile()).toBe(true);
  }
  for (const legacy of ['twin-page.tsx', 'catalog-page.tsx', 'workbench.tsx', 'ui.tsx']) {
    expect(() => statSync(join(sourceRoot, legacy))).toThrow();
  }
});

it('ARCH-08: the public CommandWorkflow contract is defined only once', () => {
  const declarations = files('application').filter((file) =>
    readFileSync(file, 'utf8').includes('export interface CommandWorkflow '),
  );
  expect(declarations.map((file) => relative(sourceRoot, file).replaceAll('\\', '/'))).toEqual(['application/contracts/CommandWorkflow.ts']);
});
