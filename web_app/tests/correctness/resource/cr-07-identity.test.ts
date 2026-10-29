import { Effect } from 'effect';
import { afterEach, expect, it, vi } from 'vitest';
import {
  ResourceDefinitionConflictError,
  defineResource,
  type ResourceDefinition,
  type ResourcePolicy,
} from '@/api/resource';
import { createTestRuntime, type AppRuntime } from '../../support/resource-test-runtime.tsx';

/**
 * 矩阵 7a / CR-07 (ADR-013 §1.2): the manager stores the typed identity of the
 * admitted definition. A same-key definition with a different kind/version or
 * policy contract must fail loudly instead of silently reusing the old handle;
 * after the idle TTL releases the key, recreating it is legal again.
 */
const runtimes: AppRuntime<never>[] = [];
const runtime = (): AppRuntime<never> => {
  const value = createTestRuntime();
  runtimes.push(value);
  return value;
};
afterEach(async () => {
  for (const value of runtimes.splice(0)) await value.dispose();
  vi.useRealTimers();
});

const definitionOf = (
  key: string,
  kind: string,
  version: number,
  policy: ResourcePolicy = { freshnessMs: 0, idleTtlMs: 300_000 },
): ResourceDefinition<string, never> => defineResource({
  identity: { kind, version, key },
  load: Effect.succeed(kind + '@' + version),
  policy,
});

it('returns the same manager-owned handle for a compatible redefinition', () => {
  const manager = runtime().resources;
  const first = manager.handle(definitionOf('same-key', 'kind-a', 1));
  const second = manager.handle(definitionOf('same-key', 'kind-a', 1));
  expect(second).toBe(first);
  expect(first.key).toBe('same-key');
  expect(manager.stats.entries).toBe(1);
});

it('throws ResourceDefinitionConflictError for a same-key different kind', () => {
  const manager = runtime().resources;
  manager.handle(definitionOf('conflict-key', 'kind-a', 1));
  let thrown: unknown;
  try {
    manager.handle(definitionOf('conflict-key', 'kind-b', 1));
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ResourceDefinitionConflictError);
  const conflict = thrown as ResourceDefinitionConflictError;
  expect(conflict.field).toBe('kind');
  expect(conflict.key).toBe('conflict-key');
  expect(conflict.existing).toEqual({ kind: 'kind-a', version: 1, key: 'conflict-key' });
  expect(conflict.incoming).toEqual({ kind: 'kind-b', version: 1, key: 'conflict-key' });
  expect(manager.stats.entries).toBe(1);
});

it('throws ResourceDefinitionConflictError for a same-key newer version', () => {
  const manager = runtime().resources;
  manager.handle(definitionOf('version-key', 'kind-a', 1));
  expect(() => manager.handle(definitionOf('version-key', 'kind-a', 2))).toThrow(ResourceDefinitionConflictError);
  try {
    manager.handle(definitionOf('version-key', 'kind-a', 2));
  } catch (error) {
    expect((error as ResourceDefinitionConflictError).field).toBe('version');
  }
});

it('throws ResourceDefinitionConflictError for an incompatible policy under the same identity', () => {
  const manager = runtime().resources;
  manager.handle(definitionOf('policy-key', 'kind-a', 1));
  expect(() => manager.handle(definitionOf('policy-key', 'kind-a', 1, { freshnessMs: 5_000, idleTtlMs: 300_000 })))
    .toThrow(ResourceDefinitionConflictError);
  expect(() => manager.handle(definitionOf('policy-key', 'kind-a', 1, { freshnessMs: 0, idleTtlMs: 300_000, pollMs: 50 })))
    .toThrow(ResourceDefinitionConflictError);
});

it('allows recreating the same key with a different identity after the idle TTL released it', async () => {
  vi.useFakeTimers();
  const manager = runtime().resources;
  const firstHandle = manager.handle(definitionOf('reclaim-key', 'kind-a', 1, { freshnessMs: 0, idleTtlMs: 20 }));
  const release = manager.retain(firstHandle);
  release();
  expect(manager.stats.entries).toBe(1);
  await vi.advanceTimersByTimeAsync(30);
  expect(manager.stats.entries, 'the released entry is gone').toBe(0);
  const recreated = manager.handle(definitionOf('reclaim-key', 'kind-b', 2, { freshnessMs: 0, idleTtlMs: 20 }));
  expect(recreated.key).toBe('reclaim-key');
  expect(manager.stats.entries).toBe(1);
  expect(manager.publish(recreated, 'b-value', 'recovery')).toEqual({ _tag: 'Publish', value: 'b-value' });
});
