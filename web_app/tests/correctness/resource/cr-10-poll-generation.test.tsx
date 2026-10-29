// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Effect } from 'effect';
import { afterEach, expect, it, vi } from 'vitest';
import { defineResource } from '@/api/resource';
import { createTestRuntime, type AppRuntime } from '../../support/resource-test-runtime.tsx';

/**
 * 矩阵 7c / CR-10 (ADR-013 §1.4): the asynchronous forkIn callback must prove it
 * still owns the polling slot (entry alive, polling intent, same generation, same
 * ResourceScope) before writing pollFiber; release increments the generation and
 * interrupts the old fiber. 1000 retain/release interleavings must never leave a
 * stale owner or a duplicate polling loop.
 */
// jsdom's import.meta.url is not a file URL; the manager source is resolved from the vitest cwd.
const MANAGER_SOURCE = readFileSync(resolve(process.cwd(), 'src/api/resource-manager.ts'), 'utf8');

const runtimes: AppRuntime<never>[] = [];
afterEach(async () => {
  for (const value of runtimes.splice(0)) await value.dispose();
  vi.useRealTimers();
});

const polledDefinition = (onLoad: () => void) => defineResource({
  identity: { kind: 'poll-probe', version: 1, key: 'poll-probe' },
  load: Effect.suspend(() => {
    onLoad();
    return Effect.succeed(onLoad);
  }),
  policy: { freshnessMs: 0, idleTtlMs: 300_000, pollMs: 20 },
});

it('validates entry/polling/generation/scope identity in the fork callback and releases the generation', () => {
  expect(MANAGER_SOURCE, 'fork callback must capture the started generation').toMatch(/startedGeneration/);
  expect(MANAGER_SOURCE, 'fork callback must capture the started scope identity').toMatch(/startedScope = entry\.scope|const scope = entry\.scope/);
  expect(MANAGER_SOURCE, 'fork callback must compare the generation').toMatch(/entry\.scopeGeneration !== startedGeneration/);
  expect(MANAGER_SOURCE, 'fork callback must compare the scope identity').toMatch(/entry\.scope !== scope/);
  expect(MANAGER_SOURCE, 'stale fork callbacks must be interrupted').toMatch(/interrupt\(fiber\)/);
  expect(MANAGER_SOURCE, 'release increments the scope generation').toMatch(/entry\.scopeGeneration \+= 1/);
});

it('1000 interleaved retain/release cycles leave exactly one poll owner and no stale fiber', async () => {
  vi.useFakeTimers();
  const runtime = createTestRuntime();
  runtimes.push(runtime);
  const manager = runtime.resources;
  let loads = 0;
  const handle = manager.handle(polledDefinition(() => { loads += 1; }));

  for (let index = 0; index < 1_000; index += 1) {
    const release = manager.retain(handle);
    if (index % 13 === 0) await Promise.resolve();
    release();
    if (index % 7 === 0) await Promise.resolve();
    expect(manager.stats.polling, 'a single resource key can never report two poll owners').toBeLessThanOrEqual(1);
  }
  expect(manager.stats.polling, 'all released cycles stop their poll owner').toBe(0);
  await vi.advanceTimersByTimeAsync(100);
  expect(manager.stats.polling, 'no stale released fiber revives polling').toBe(0);

  // One final owner: exactly one poll per interval (a stale loop would double this).
  const release = manager.retain(handle);
  await vi.advanceTimersByTimeAsync(1);
  expect(manager.stats.polling).toBe(1);
  const afterMount = loads;
  await vi.advanceTimersByTimeAsync(20);
  expect(loads - afterMount, 'one poll owner means one poll per period').toBe(1);
  await vi.advanceTimersByTimeAsync(20);
  expect(loads - afterMount).toBe(2);
  expect(manager.stats.polling).toBe(1);
  release();
  const afterRelease = loads;
  await vi.advanceTimersByTimeAsync(100);
  expect(loads, 'releasing the last subscriber stops the single poll loop').toBe(afterRelease);
  expect(manager.stats.polling).toBe(0);
  expect(manager.stats.scopes).toBe(0);
});

it('dispose leaves zero active poll owners and no further loads', async () => {
  vi.useFakeTimers();
  const runtime = createTestRuntime();
  const manager = runtime.resources;
  let loads = 0;
  const handle = manager.handle(polledDefinition(() => { loads += 1; }));
  const release = manager.retain(handle);
  await vi.advanceTimersByTimeAsync(1);
  expect(manager.stats.polling).toBe(1);
  release();
  await runtime.dispose();
  expect(manager.stats.polling).toBe(0);
  expect(manager.stats.entries).toBe(0);
  const before = loads;
  await vi.advanceTimersByTimeAsync(200);
  expect(loads).toBe(before);
});