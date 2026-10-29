import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Effect, Layer } from 'effect';
import { afterEach, expect, it, vi } from 'vitest';
import { ResourceCapacityError, defineResource } from '@/api/resource';
import { createApplicationRuntime, type AppRuntime } from '@/app/app-runtime';
import { createTestRuntime } from '../../support/resource-test-runtime.tsx';

/**
 * 矩阵 7b / CR-09 (ADR-013 §1.3): a single 256 hard capacity. Reaching the limit
 * first releases zero-subscriber entries by idle LRU; if nothing can be freed the
 * new identity is rejected. The unreachable 512 second waterline must stay deleted.
 */
const MANAGER_SOURCE = readFileSync(
  fileURLToPath(new URL('../../../src/api/resource-manager.ts', import.meta.url)),
  'utf8',
);

const runtimes: AppRuntime<never>[] = [];
afterEach(async () => {
  for (const value of runtimes.splice(0)) await value.dispose();
  vi.useRealTimers();
});

const definitionOf = (index: number, idleTtlMs = 300_000) => defineResource({
  identity: { kind: 'capacity-probe', version: 1, key: 'capacity\u0000' + index },
  load: Effect.succeed(index),
  policy: { freshnessMs: 0, idleTtlMs },
});

it('declares exactly one 256 hard capacity (no dead 512 waterline)', () => {
  expect(MANAGER_SOURCE).toMatch(/const MAX_ENTRIES = 256/);
  expect(MANAGER_SOURCE).not.toMatch(/MAX_ENTRIES_HARD/);
  // The rejection path must be the same single limit that gates eviction.
  expect(MANAGER_SOURCE).toMatch(/if \(entries\.size >= MAX_ENTRIES\)/);
});

it('admits exactly 256 retained entries, then rejects with ResourceCapacityError', () => {
  vi.useFakeTimers();
  const runtime = createTestRuntime();
  runtimes.push(runtime);
  const manager = runtime.resources;
  const releases: Array<() => void> = [];
  for (let index = 0; index < 256; index += 1) {
    const handle = manager.handle(definitionOf(index));
    releases.push(manager.retain(handle));
    expect(manager.stats.entries).toBe(index + 1);
  }
  let thrown: unknown;
  try {
    manager.handle(definitionOf(256));
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ResourceCapacityError);
  expect((thrown as ResourceCapacityError).capacity).toBe(256);
  expect(manager.stats.entries, 'a rejected identity is not admitted').toBe(256);
  expect(manager.diagnostics.some((entry) => entry.reason === 'capacity')).toBe(true);
  for (const release of releases) release();
});

it('frees a zero-subscriber idle entry to admit a new key (single limit, no hard waterline)', () => {
  vi.useFakeTimers();
  const runtime = createTestRuntime();
  runtimes.push(runtime);
  const manager = runtime.resources;
  const releases: Array<() => void> = [];
  for (let index = 0; index < 256; index += 1) {
    const handle = manager.handle(definitionOf(index));
    releases.push(manager.retain(handle));
  }
  expect(manager.stats.entries).toBe(256);
  // Retained entries are not evictable: the limit is hard for live subscribers.
  expect(() => manager.handle(definitionOf(256))).toThrow(ResourceCapacityError);
  // Releasing one subscriber exceeds the subscriber constraint but keeps the entry
  // until the idle TTL, so the slot is reclaimed by idle-LRU eviction, not by luck.
  releases[0]();
  expect(manager.stats.entries).toBe(256);
  expect(manager.handle(definitionOf(256))).toBeDefined();
  expect(manager.stats.entries).toBe(256);
  // Re-entering the evicted key is legal: its identity reservation is gone with the entry.
  expect(manager.handle(definitionOf(0))).toBeDefined();
  expect(manager.stats.entries).toBe(256);
  for (const release of releases.slice(1)) release();
});

it('keeps 3000-identity churn bounded and only ResourceCapacityError can reject a handle()', async () => {
  vi.useFakeTimers();
  const runtime = createApplicationRuntime({ layer: Layer.empty, defaultIdleTTL: 80 });
  runtimes.push(runtime);
  const manager = runtime.resources;
  const errors: unknown[] = [];
  for (let index = 0; index < 3_000; index += 1) {
    try {
      const handle = manager.handle(definitionOf(index, 20));
      const release = manager.retain(handle);
      if (index % 7 === 0) await Promise.resolve();
      release();
    } catch (error) {
      errors.push(error);
    }
    expect(manager.stats.entries).toBeLessThanOrEqual(256);
    if (index % 31 === 0) await vi.advanceTimersByTimeAsync(25);
  }
  expect(errors.every((error) => error instanceof ResourceCapacityError)).toBe(true);
  expect(manager.stats.entries).toBeLessThanOrEqual(256);
  await vi.advanceTimersByTimeAsync(100);
  expect(manager.stats.entries).toBe(0);
});
