// @vitest-environment jsdom
import { RegistryContext } from '@effect/atom-react';
import { Effect } from 'effect';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { defineResource } from '@/api/resource';
import { useResource } from '@/api/use-resource';
import { createTestRuntime, type AppRuntime } from '../support/resource-test-runtime.tsx';

/**
 * CORE-002 (INV-02/INV-05, G05): two consumers of one resource identity share a
 * single in-flight request and exactly one polling owner. The previous
 * implementation created one `setInterval` per component (RED: one 20ms period
 * produced 2 loads).
 */
const runtimes: AppRuntime<never>[] = [];
afterEach(async () => {
  for (const value of runtimes.splice(0)) await value.dispose();
  vi.useRealTimers();
});

it('shares one request and owns exactly one polling fiber for two consumers', async () => {
  const runtime = createTestRuntime();
  runtimes.push(runtime);
  let loads = 0;
  const definition = defineResource({
    identity: { kind: 'polled-resource', version: 1, key: 'polled-resource' },
    load: Effect.suspend(() => {
      loads += 1;
      return Effect.succeed(loads);
    }),
    policy: { freshnessMs: 0, idleTtlMs: 300_000, pollMs: 20 },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <RegistryContext.Provider value={runtime.registry}>{children}</RegistryContext.Provider>
  );

  vi.useFakeTimers();
  const first = renderHook(() => useResource(runtime, definition), { wrapper });
  const second = renderHook(() => useResource(runtime, definition), { wrapper });
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });

  expect(runtime.resources.stats.polling, 'one poll fiber per resource key').toBe(1);
  const afterMount = loads;
  expect(afterMount, 'concurrent mounts share one in-flight read').toBe(1);

  await act(async () => { await vi.advanceTimersByTimeAsync(20); });
  expect(loads - afterMount, 'exactly one poll per period, not one per consumer').toBe(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(20); });
  expect(loads - afterMount).toBe(2);
  expect(first.result.current.data, 'both consumers read the same latest Atom value').toBe(loads);
  expect(second.result.current.data).toBe(loads);

  first.unmount();
  await act(async () => { await vi.advanceTimersByTimeAsync(20); });
  expect(loads - afterMount, 'the remaining consumer keeps the single poll owner').toBe(3);
  expect(runtime.resources.stats.polling).toBe(1);

  second.unmount();
  const afterUnmount = loads;
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  expect(loads, 'zero subscribers stop polling immediately').toBe(afterUnmount);
  expect(runtime.resources.stats.polling).toBe(0);
  expect(runtime.resources.stats.scopes).toBe(0);
});

it('a loader ensure and a mounted consumer share the same in-flight read', async () => {
  const runtime = createTestRuntime();
  runtimes.push(runtime);
  let loads = 0;
  const definition = defineResource({
    identity: { kind: 'loader-shared', version: 1, key: 'loader-shared' },
    load: Effect.suspend(() => {
      loads += 1;
      return Effect.suspend(() => Effect.succeed(loads)).pipe(Effect.delay('10 millis'));
    }),
    policy: { freshnessMs: 0, idleTtlMs: 300_000 },
  });
  const manager = runtime.resources;
  // Router-loader style call (no retain) and the component mount race.
  const loader = manager.ensure(manager.handle(definition));
  const mounted = manager.ensure(manager.handle(definition));
  await Promise.all([loader, mounted]);
  expect(loads, 'loader prefetch and mount share one request').toBe(1);
  expect(manager.value(manager.handle(definition))).toBe(1);
});
