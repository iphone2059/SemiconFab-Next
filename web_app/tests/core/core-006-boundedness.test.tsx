// @vitest-environment jsdom
import { Effect, Layer } from 'effect';
import { afterEach, expect, it, vi } from 'vitest';
import { ResourceCapacityError, defineResource } from '@/api/resource';
import { createApplicationRuntime, type AppRuntime } from '@/app/app-runtime';
import { createTestRuntime } from '../support/resource-test-runtime.tsx';

/**
 * CORE-006 (INV-06, G02): dynamic resource definitions, manager entries, Atom
 * nodes, resource scopes and polling fibers all stay bounded when thousands of
 * unique Run identities mount/unmount/expire. The previous `resourceFamily`
 * `Map<Key, Resource>` grew forever.
 */
const runtimes: AppRuntime<never>[] = [];
afterEach(async () => {
  for (const value of runtimes.splice(0)) await value.dispose();
  vi.useRealTimers();
});

const dynamicDefinition = (index: number, idleTtlMs: number) => defineResource({
  identity: { kind: 'run-detail', version: 1, key: 'run\u0000id-' + index },
  load: Effect.succeed(index),
  policy: { freshnessMs: 0, idleTtlMs },
});

it('1000+ unique dynamic identities are reclaimed by the idle TTL and capacity LRU', async () => {
  const runtime = createApplicationRuntime({ layer: Layer.empty, defaultIdleTTL: 80 });
  runtimes.push(runtime);
  const manager = runtime.resources;

  for (let index = 0; index < 1_200; index += 1) {
    const handle = manager.handle(dynamicDefinition(index, 20));
    const release = manager.retain(handle);
    release();
  }
  expect(manager.stats.entries, 'soft capacity bounds live entries').toBeLessThanOrEqual(256);
  expect(manager.stats.scopes, 'released subscriptions own no scope').toBe(0);
  expect(manager.stats.polling).toBe(0);

  await expect.poll(() => manager.stats.entries, { timeout: 5_000 }).toBe(0);
  expect(manager.stats.scopes).toBe(0);
  expect(manager.stats.polling).toBe(0);

  // Atom nodes are reclaimed by the registry idle TTL, not just the manager map.
  await expect.poll(() => runtime.registry.getNodes().size, { timeout: 10_000 }).toBeLessThanOrEqual(16);
});

it('hard capacity rejects a new identity with ResourceCapacityError instead of growing unbounded', () => {
  vi.useFakeTimers();
  const runtime = createTestRuntime();
  runtimes.push(runtime);
  const manager = runtime.resources;
  const releases: Array<() => void> = [];
  for (let index = 0; index < 256; index += 1) {
    const handle = manager.handle(dynamicDefinition(index, 300_000));
    releases.push(manager.retain(handle));
  }
  expect(manager.stats.entries).toBe(256);
  let thrown: unknown;
  try {
    manager.handle(dynamicDefinition(999, 300_000));
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ResourceCapacityError);
  expect((thrown as ResourceCapacityError).key).toBe('run\u0000id-999');
  expect(manager.stats.entries, 'rejection does not admit the entry').toBe(256);
  expect(manager.diagnostics.some((entry) => entry.reason === 'capacity')).toBe(true);

  for (const release of releases) release();
});
