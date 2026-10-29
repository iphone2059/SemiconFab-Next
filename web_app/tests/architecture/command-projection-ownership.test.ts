import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

/**
 * Phase C ownership gates (ADR-007 §3/§4/§6, INV-07/08/09/10/11):
 * one projection store written only by FabRuntime, one reconciliation scheduler
 * as the only authoritative entry, no unbounded Atom family, and no legacy
 * workflow Scope or global command stream. These are source-level proofs that
 * the deleted paths cannot regress silently.
 */
const sourceRoot = fileURLToPath(new URL('../../src/', import.meta.url));

function sourceFiles(directory: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory)) {
    const absolute = join(directory, entry);
    if (statSync(absolute).isDirectory()) out.push(...sourceFiles(absolute));
    else if (/\.(?:ts|tsx)$/.test(entry)) out.push(absolute);
  }
  return out;
}

const relativeToSource = (file: string): string => relative(sourceRoot, file).replaceAll('\\', '/');
/** Comments may describe removed APIs; gates inspect code only. */
const stripComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const files = (): Array<{ path: string; text: string }> =>
  sourceFiles(sourceRoot).map((file) => ({ path: relativeToSource(file), text: stripComments(readFileSync(file, 'utf8')) }));

it('removes the unbounded command projection family and the shared workflow Scope', () => {
  const text = files().map((file) => file.text).join('\n');
  // Only comments may mention the removed APIs.
  expect(text.match(/Atom\.family\s*\(/g) ?? []).toEqual([]);
  expect(text.match(/commandProjectionAtom|commandProjectionKey/g) ?? []).toEqual([]);
  expect(text.match(/EffectCommandWorkflowScope|command-workflow-scope/g) ?? []).toEqual([]);
  expect(() => statSync(join(sourceRoot, 'runtime', 'command-projection.atom.ts'))).toThrow();
  expect(() => statSync(join(sourceRoot, 'runtime', 'command-workflow-scope.ts'))).toThrow();
});

it('keeps the bounded projection store as the only projection writer used by FabRuntime', () => {
  const storeImporters = files()
    .filter((file) => /from '@\/runtime\/command-projection\.store'/.test(file.text))
    .map((file) => file.path)
    .sort();
  // FabRuntime owns the store; app/runtime-provider only reads through the runtime.
  expect(storeImporters).toEqual(['runtime/fab-runtime.ts']);

  const provider = stripComments(readFileSync(join(sourceRoot, 'app/runtime-provider.tsx'), 'utf8'));
  // Single data source: Atom subscription only, no local React state fallback and
  // no runtime broadcast path (INV-11).
  expect(provider).toContain('useAtomValue');
  expect(provider).toContain('projectionAtom');
  expect(provider).not.toContain('useState');
  expect(provider).not.toContain('runtime.subscribe');
  expect(provider).not.toContain('getProjection');
  expect(provider).not.toContain('sameProjection');

  const runtime = stripComments(readFileSync(join(sourceRoot, 'runtime/fab-runtime.ts'), 'utf8'));
  // Invalidation on eviction/dispose/FAB rebuild is part of the store contract.
  expect(runtime).toContain('projectionStore.retain');
  expect(runtime).toContain('projectionStore.invalidateAll');
  expect(runtime).toContain('projectionStore.forget');
});

it('keeps FabReconciliationScheduler as the single authoritative reconciliation entry', () => {
  const runtime = stripComments(readFileSync(join(sourceRoot, 'runtime/fab-runtime.ts'), 'utf8'));
  // FabRuntime never calls the gateway status query or a reconciler directly; all
  // reconciliation goes through scheduler.schedule/scheduleMany
  // (recovery listing/journal calls are the documented ADR-008 recovery path).
  expect(runtime).not.toMatch(/getCommandStatus\s*\(/);
  expect(runtime).not.toMatch(/\.reconcile\s*\(/);
  expect(runtime).toContain('scheduler.schedule');
  expect(runtime).toContain('scheduler.scheduleMany');

  const scheduler = stripComments(readFileSync(join(sourceRoot, 'runtime/fab-reconciliation-scheduler.ts'), 'utf8'));
  expect(scheduler).toContain('Semaphore.makeUnsafe');
  expect(scheduler).toContain('CommandReconciler');
  expect(scheduler).toContain('maxQueued');
  expect(scheduler).toContain('Scope.forkUnsafe');

  // The bridge only transports/dedupes events; it must not run Effects itself.
  const bridge = stripComments(readFileSync(join(sourceRoot, 'runtime/command-event-bridge.ts'), 'utf8'));
  expect(bridge).not.toMatch(/Effect\.(?:run|runPromise|runSync|runFork)\b/);
});

it('keeps command scopes per command and the bounded transport inside FabRuntime scopes', () => {
  const runtime = stripComments(readFileSync(join(sourceRoot, 'runtime/fab-runtime.ts'), 'utf8'));
  expect(runtime).toContain('Scope.forkUnsafe');
  expect(runtime).toContain('transportScope');
  expect(runtime).toContain('commandScopes');
  expect(runtime).toContain('Effect.acquireRelease');
  expect(runtime).toContain('Scope.close');
  const stream = stripComments(readFileSync(join(sourceRoot, 'runtime/command-stream.ts'), 'utf8'));
  expect(stream).toContain('Effect.forkIn');
  expect(stream).not.toContain('Effect.run');
});
