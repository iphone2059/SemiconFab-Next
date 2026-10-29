import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

/**
 * Task 2 architecture gate: Effect execution and registry construction are
 * composition-root concerns. Business modules export Effects; they must not run
 * them or construct a second registry/runtime on their own.
 */
const sourceRoot = fileURLToPath(new URL('../../src/', import.meta.url));

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(absolute));
    else if (/\.(?:ts|tsx)$/.test(entry.name)) files.push(absolute);
  }
  return files.sort();
}

const relativeToSource = (file: string): string => relative(sourceRoot, file).replaceAll('\\', '/');

const ALLOWED_RUNNERS = new Set([
  'app/app-runtime.ts',
  // Task 4 stage B: Effect Scope owns XState actor acquire/release finalizers.
  'runtime/command-workflow-scope.ts',
  // Transitional Task 3 adapters: Query queryFns/UI controllers still run the
  // typed Effects at the old edge until Task 5 moves them onto resource atoms.
  'api/catalog.resource.ts',
  'api/equipment.resource.ts',
  'api/research.resource.ts',
  'api/runs.resource.ts',
  'api/sites.resource.ts',
  'api/wafer.resource.ts',
  'app/runtime-bootstrap.tsx',
  'workbench/use-command-console.ts',
  'workbench/use-run-submission.ts',
]);
const ALLOWED_REGISTRY = new Set(['app/app-runtime.ts']);
const ALLOWED_MANAGED_RUNTIME = new Set(['app/app-runtime.ts']);
const ALLOWED_REGISTRY_PROVIDER = new Set(['app/app-providers.tsx']);

it('Effect.run* is confined to the AppRuntime composition root', () => {
  const violations: string[] = [];
  for (const file of sourceFiles(sourceRoot)) {
    const path = relativeToSource(file);
    const text = readFileSync(file, 'utf8');
    if (/\bEffect\.(?:run|runPromise|runSync|runFork|runSyncExit|runPromiseExit|runCallback)\b/.test(text) && !ALLOWED_RUNNERS.has(path)) {
      violations.push(path + ' executes an Effect outside app/app-runtime.ts');
    }
  }
  expect(violations).toEqual([]);
});

it('constructs exactly one registry/managed runtime at the composition root', () => {
  const violations: string[] = [];
  for (const file of sourceFiles(sourceRoot)) {
    const path = relativeToSource(file);
    const text = readFileSync(file, 'utf8');
    if (/\bAtomRegistry\.make\(/.test(text) && !ALLOWED_REGISTRY.has(path)) {
      violations.push(path + ' constructs an AtomRegistry outside app/app-runtime.ts');
    }
    if (/\bManagedRuntime\.make\(/.test(text) && !ALLOWED_MANAGED_RUNTIME.has(path)) {
      violations.push(path + ' constructs a ManagedRuntime outside app/app-runtime.ts');
    }
    if (/RegistryContext\.Provider/.test(text) && !ALLOWED_REGISTRY_PROVIDER.has(path)) {
      violations.push(path + ' mounts RegistryContext.Provider outside app/app-providers.tsx');
    }
  }
  expect(violations).toEqual([]);
  const providers = readFileSync(join(sourceRoot, 'app/app-providers.tsx'), 'utf8');
  expect(providers).toContain('runtime.registry');
});
