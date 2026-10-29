import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

/**
 * Phase C architecture gate (ADR-007 §2): Effect execution and registry
 * construction are composition-root concerns. Business modules export Effects;
 * they must not run them, construct a second registry/runtime, or own an
 * unowned PubSub. The only allowed global Effect runner is app/app-runtime.ts.
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
/** Comments may describe removed APIs; gates inspect code only. */
const stripComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const ALLOWED_RUNNERS = new Set(['app/app-runtime.ts']);
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

it('never constructs an unbounded PubSub or a detached command stream fiber', () => {
  const violations: string[] = [];
  for (const file of sourceFiles(sourceRoot)) {
    const path = relativeToSource(file);
    const text = stripComments(readFileSync(file, 'utf8'));
    if (/PubSub\.unbounded/.test(text)) violations.push(path + ' constructs PubSub.unbounded');
    if (/\bEffect\.runFork\b|\bEffect\.run\b/.test(text)) violations.push(path + ' uses a global Effect runner');
  }
  expect(violations).toEqual([]);
  // The command transport must stay bounded and PubSub-free (ADR-007 §5).
  const transport = stripComments(readFileSync(join(sourceRoot, 'realtime/command-event-source.transport.ts'), 'utf8'));
  expect(transport).not.toMatch(/PubSub/);
  expect(transport).toContain('capacity');
  expect(transport).toContain("'dirty'");
});
