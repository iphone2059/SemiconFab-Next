// @vitest-environment jsdom
import { RegistryContext } from '@effect/atom-react';
import { Effect, Layer } from 'effect';
import * as AsyncResult from 'effect/reactivity/AsyncResult';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApplicationRuntime, type AppRuntime } from '@/app/app-runtime';
import { defineResource } from '@/api/resource';
import { useResource } from '@/api/use-resource';
import { RESOURCE_POLICIES } from '@/api/resource-policy';
import { catalogDefinition } from '@/api/catalog.resource';
import { researchEventsDefinition } from '@/api/research.resource';
import { runDefinition, runKey, runResultsDefinition, runsDefinition } from '@/api/runs.resource';
import { sitesDefinition } from '@/api/sites.resource';
import { waferRoutesDefinition } from '@/api/wafer.resource';

/**
 * ResourceManager public contract (ADR-006 §2.6/§2.8): single-flight, freshness vs
 * idle TTL, single polling owner, commit-only writes and the React binding.
 */
const runtimes: AppRuntime<never>[] = [];
const runtime = (options: { defaultIdleTTL?: number } = {}): AppRuntime<never> => {
  const value = createApplicationRuntime({ layer: Layer.empty, ...options });
  runtimes.push(value);
  return value;
};
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(async () => {
  for (const value of runtimes.splice(0)) await value.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('ResourceManager', () => {
  it('shares one in-flight request between concurrent ensure calls and reuses fresh values', async () => {
    const client = runtime();
    const manager = client.resources;
    let loads = 0;
    const definition = defineResource({
      key: 'single-flight',
      load: Effect.suspend(() => { loads += 1; return Effect.sleep('20 millis').pipe(Effect.as(loads)); }),
      policy: { freshnessMs: 500, idleTtlMs: 300_000 },
    });
    const handle = manager.handle(definition);
    const [first, second] = await Promise.all([manager.ensure(handle), manager.ensure(handle)]);
    expect(loads).toBe(1);
    expect(first).toBe(second);
    await expect(manager.ensure(handle)).resolves.toBe(second);
    expect(loads).toBe(1);
    expect(manager.stats.inFlight).toBe(0);
    expect(manager.value(handle)).toBe(second);
  });

  it('refreshes stale values while retaining the previous value, and keeps it on typed failure', async () => {
    const client = runtime();
    const manager = client.resources;
    let loads = 0;
    const definition = defineResource({
      key: 'refresh-semantics',
      load: Effect.suspend(() => {
        loads += 1;
        return loads === 1 ? Effect.succeed('old') : loads === 2 ? Effect.sleep('20 millis').pipe(Effect.as('new')) : Effect.fail(new Error('refresh failed'));
      }),
      policy: { freshnessMs: 0, idleTtlMs: 300_000 },
    });
    const handle = manager.handle(definition);
    await manager.ensure(handle);
    const refresh = manager.refresh(handle);
    // Refreshing keeps the same success value visible while waiting.
    const waiting = manager.state(handle);
    expect(AsyncResult.isSuccess(waiting)).toBe(true);
    expect(waiting.waiting).toBe(true);
    expect(manager.value(handle)).toBe('old');
    await expect(refresh).resolves.toBe('new');

    await expect(manager.refresh(handle)).rejects.toThrow('refresh failed');
    const failed = manager.state(handle);
    expect(AsyncResult.isFailure(failed)).toBe(true);
    if (AsyncResult.isFailure(failed)) expect(failed.previousSuccess._tag).toBe('Some');
    expect(manager.value(handle)).toBe('new');
  });

  it('distinguishes freshness from idle TTL: a released entry is reclaimed after idleTtlMs', async () => {
    vi.useFakeTimers();
    const client = runtime();
    const manager = client.resources;
    let loads = 0;
    const definition = defineResource({
      key: 'idle-ttl',
      load: Effect.suspend(() => { loads += 1; return Effect.succeed(loads); }),
      policy: { freshnessMs: Number.POSITIVE_INFINITY, idleTtlMs: 20 },
    });
    const handle = manager.handle(definition);
    const release = manager.retain(handle);
    expect(await manager.ensure(handle)).toBe(1);
    release();
    expect(manager.stats.entries).toBe(1);
    await vi.advanceTimersByTimeAsync(30);
    expect(manager.stats.entries, 'idle TTL releases the control metadata').toBe(0);
    expect(manager.stats.scopes).toBe(0);
    // A fresh handle after reclamation revalidates instead of reusing a stale success.
    const recreated = manager.handle(definition);
    expect(await manager.ensure(recreated)).toBe(2);
  });

  it('publishes transport snapshots through the commit port and only refreshes the affected key', async () => {
    const client = runtime();
    const manager = client.resources;
    let loads = 0;
    const makeDefinition = (key: string) => defineResource({
      key,
      load: Effect.suspend(() => { loads += 1; return Effect.succeed(key + ':' + loads); }),
      policy: { freshnessMs: 0, idleTtlMs: 300_000 },
    });
    const handleA = manager.handle(makeDefinition('a'));
    const handleB = manager.handle(makeDefinition('b'));
    expect(manager.publish(handleA, 'seeded-a', 'recovery')).toEqual({ _tag: 'Publish', value: 'seeded-a' });
    expect(manager.value(handleA)).toBe('seeded-a');
    await manager.refresh(handleA);
    expect(manager.value(handleA)).toBe('a:1');
    expect(manager.value(handleB), 'the other resource is untouched').toBeUndefined();
    await manager.refresh(handleB);
    expect(manager.value(handleB)).toBe('b:2');
  });

  it('exposes the documented policies and deterministic dynamic keys', () => {
    expect(sitesDefinition.policy).toEqual(RESOURCE_POLICIES.sites);
    expect(catalogDefinition.policy.freshnessMs).toBe(60_000);
    expect(researchEventsDefinition.policy.idleTtlMs).toBe(600_000);
    expect(waferRoutesDefinition.policy.freshnessMs).toBe(Number.POSITIVE_INFINITY);
    expect(runsDefinition.policy.pollMs).toBe(1500);
    expect(runDefinition('run-a').key).toBe(runKey('run-a'));
    expect(runDefinition('run-a').key).not.toBe(runDefinition('run-b').key);
    expect(runResultsDefinition('run-a').policy.pollMs).toBeUndefined();
  });
});

describe('useResource binding', () => {
  const wrap = (client: AppRuntime<never>) =>
    ({ children }: { children: ReactNode }) => <RegistryContext.Provider value={client.registry}>{children}</RegistryContext.Provider>;

  it('revalidates on mount, polls while mounted, and stops after unmount', async () => {
    const client = runtime();
    let loads = 0;
    const definition = defineResource({
      key: 'hooked',
      load: Effect.suspend(() => { loads += 1; return Effect.succeed(loads); }),
      policy: { freshnessMs: 0, idleTtlMs: 300_000, pollMs: 20 },
    });
    const view = renderHook(() => useResource(client, definition), { wrapper: wrap(client) });
    await waitFor(() => expect(view.result.current.data).toBeDefined());
    const afterMount = loads;
    await act(async () => { await delay(70); });
    expect(loads).toBeGreaterThan(afterMount);
    expect(client.resources.stats.polling).toBe(1);
    const beforeUnmount = loads;
    view.unmount();
    await delay(70);
    expect(loads).toBe(beforeUnmount);
    expect(client.resources.stats.polling).toBe(0);
  });

  it('honors enabled=false without retaining/loading, while the Atom stays readable', async () => {
    const client = runtime();
    const manager = client.resources;
    let calls = 0;
    const definition = defineResource({
      key: 'toggle',
      load: Effect.suspend(() => { calls += 1; return Effect.succeed('value'); }),
      policy: { freshnessMs: 0, idleTtlMs: 300_000 },
    });
    const disabled = renderHook(() => useResource(client, definition, { enabled: false }), { wrapper: wrap(client) });
    expect(disabled.result.current.data).toBeUndefined();
    expect(calls).toBe(0);
    expect(manager.stats.scopes).toBe(0);
    manager.publish(manager.handle(definition), 'seeded');
    await waitFor(() => expect(disabled.result.current.data).toBe('seeded'));
    disabled.unmount();

    const view = renderHook(() => useResource(client, definition), { wrapper: wrap(client) });
    await waitFor(() => expect(calls).toBe(1), { timeout: 2_000 });
    expect(view.result.current.data).toBe('value');
    expect(client.resources.state(client.resources.handle(definition))._tag).toBe('Success');
  });
});
