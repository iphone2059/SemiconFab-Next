// @vitest-environment jsdom
import { RegistryContext } from '@effect/atom-react';
import { Effect, Layer } from 'effect';
import * as AsyncResult from 'effect/reactivity/AsyncResult';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ReactNode } from 'react';
import { createApplicationRuntime, type AppRuntime } from '@/app/app-runtime';
import { ensureResource, invalidateResource, makeResource, refreshResource, resourceValue, setResourceValue } from '@/api/resource';
import { useResource } from '@/api/use-resource';
import { RESOURCE_POLICIES } from '@/api/resource-policy';
import { runResource, runResultsResource, runsResource } from '@/api/runs.resource';
import { sitesResource as sites } from '@/api/sites.resource';
import { catalogResource } from '@/api/catalog.resource';
import { researchEventsResource } from '@/api/research.resource';
import { waferRoutesResource } from '@/api/wafer.resource';

const runtimes: AppRuntime<never>[] = [];
const runtime = (): AppRuntime<never> => {
  const value = createApplicationRuntime({ layer: Layer.empty });
  runtimes.push(value);
  return value;
};
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const sleepEffect = Effect.sleep('20 millis');

afterEach(async () => {
  for (const value of runtimes.splice(0)) await value.dispose();
});

describe('resource Atom foundation', () => {
  it('shares one in-flight request between concurrent ensure calls and reuses fresh values', async () => {
    const rt = runtime();
    let loads = 0;
    const resource = makeResource(Effect.suspend(() => { loads += 1; return sleepEffect.pipe(Effect.as(loads)); }), { freshnessMs: 500, idleTtlMs: 300_000 });
    const [first, second] = await Promise.all([ensureResource(rt, resource), ensureResource(rt, resource)]);
    expect(loads).toBe(1);
    expect(first).toBe(second);
    await expect(ensureResource(rt, resource)).resolves.toBe(second);
    expect(loads).toBe(1);
  });

  it('refreshes stale values while retaining the previous value, and keeps it on typed failure', async () => {
    const rt = runtime();
    let loads = 0;
    const resource = makeResource(
      Effect.suspend(() => {
        loads += 1;
        return loads === 1 ? Effect.succeed('old') : loads === 2 ? sleepEffect.pipe(Effect.as('new')) : Effect.fail(new Error('refresh failed'));
      }),
      { freshnessMs: 0, idleTtlMs: 300_000 },
    );
    await ensureResource(rt, resource);
    const refresh = refreshResource(rt, resource);
    expect(AsyncResult.isSuccess(rt.registry.get(resource.atom))).toBe(true);
    expect(resourceValue(rt.registry, resource)).toBe('old');
    await expect(refresh).resolves.toBe('new');
    await expect(refreshResource(rt, resource)).rejects.toThrow('refresh failed');
    const result = rt.registry.get(resource.atom);
    expect(AsyncResult.isFailure(result)).toBe(true);
    if (AsyncResult.isFailure(result)) expect(result.previousSuccess._tag).toBe('Some');
    // The retained value is explicitly not a fresh success: the error is still typed.
    expect(resourceValue(rt.registry, resource)).toBe('new');
  });

  it('distinguishes freshness from idle TTL: an idle-disposed Atom revalidates on mount', async () => {
    // The registry default TTL enables the timeout bucket; the resource's own
    // Atom.setIdleTTL overrides the retention for this atom.
    const rt = createApplicationRuntime({ layer: Layer.empty, defaultIdleTTL: 20 });
    runtimes.push(rt);
    let loads = 0;
    const resource = makeResource(Effect.suspend(() => { loads += 1; return Effect.succeed(loads); }), { freshnessMs: Number.POSITIVE_INFINITY, idleTtlMs: 20 });
    expect(resource.atom.idleTTL).toBe(20);
    const release = rt.registry.mount(resource.atom);
    expect(await ensureResource(rt, resource)).toBe(1);
    release();
    await delay(120);
    expect(rt.registry.getNodes().has(resource.atom), 'idle TTL reclaims the node even though freshness is infinite').toBe(false);
    expect(await ensureResource(rt, resource)).toBe(2);
  });

  it('publishes SSE/mutation snapshots and invalidates only the affected resource', async () => {
    const rt = runtime();
    let loads = 0;
    const resource = makeResource(Effect.suspend(() => { loads += 1; return Effect.succeed('loaded'); }), { freshnessMs: 0, idleTtlMs: 300_000 });
    setResourceValue(rt, resource, 'sse');
    expect(resourceValue(rt.registry, resource)).toBe('sse');
    invalidateResource(rt, resource);
    await waitFor(() => expect(resourceValue(rt.registry, resource)).toBe('loaded'));
    expect(loads).toBe(1);
  });

  it('exposes the documented policies and deterministic resource family identity', () => {
    expect(sites.policy).toEqual(RESOURCE_POLICIES.sites);
    expect(catalogResource.policy.freshnessMs).toBe(60_000);
    expect(researchEventsResource.policy.idleTtlMs).toBe(600_000);
    expect(waferRoutesResource.policy.freshnessMs).toBe(Number.POSITIVE_INFINITY);
    expect(runsResource.policy.pollMs).toBe(1500);
    expect(runResource('run-a')).toBe(runResource('run-a'));
    expect(runResource('run-a')).not.toBe(runResource('run-b'));
    expect(runResultsResource('run-a').policy.pollMs).toBeUndefined();
  });
});

describe('useResource', () => {
  const wrap = (rt: AppRuntime<never>) =>
    ({ children }: { children: ReactNode }) => <RegistryContext.Provider value={rt.registry}>{children}</RegistryContext.Provider>;

  it('revalidates on mount, polls while mounted, and stops after unmount', async () => {
    const rt = runtime();
    let loads = 0;
    const resource = makeResource(Effect.suspend(() => { loads += 1; return Effect.succeed(loads); }), { freshnessMs: 0, idleTtlMs: 300_000, pollMs: 20 });
    const view = renderHook(() => useResource(rt, resource), { wrapper: wrap(rt) });
    await waitFor(() => expect(view.result.current.data).toBeDefined());
    const afterMount = loads;
    await act(async () => { await delay(70); });
    expect(loads).toBeGreaterThan(afterMount);
    const beforeUnmount = loads;
    view.unmount();
    await delay(70);
    expect(loads).toBe(beforeUnmount);
  });

  it('honors enabled=false and keeps the retained value visible during a failed refresh', async () => {
    const rt = runtime();
    let calls = 0;
    const resource = makeResource(Effect.suspend(() => { calls += 1; return calls === 1 ? Effect.succeed('value') : Effect.fail(new Error('boom')); }), { freshnessMs: 0, idleTtlMs: 300_000 });
    const disabled = renderHook(() => useResource(rt, resource, { enabled: false }), { wrapper: wrap(rt) });
    expect(disabled.result.current.data).toBeUndefined();
    expect(calls).toBe(0);
    disabled.unmount();

    const view = renderHook(() => useResource(rt, resource), { wrapper: wrap(rt) });
    await waitFor(() => expect(view.result.current.data).toBe('value'));
    await act(async () => { view.result.current.refresh(); await delay(20); });
    expect(view.result.current.isError).toBe(true);
    expect(view.result.current.data).toBe('value');
  });
});
