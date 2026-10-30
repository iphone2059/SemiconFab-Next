import { expect, it, vi } from 'vitest';
import type { FabIdentity } from '@/domain/fab-identity';
import { FabTelemetryRegistry } from '@/realtime/telemetry-registry';
import type { TelemetryRuntime } from '@/realtime/telemetry-runtime';

type FakeRuntime = TelemetryRuntime & { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };

/** R5.4-03 spec fixture: two sites that both own a FAB with the same fabId. */
const siteAFab01 = { siteId: 'site-a', fabId: 'fab-01' } as const;
const siteBFab01 = { siteId: 'site-b', fabId: 'fab-01' } as const;
const siteBFab02 = { siteId: 'site-b', fabId: 'fab-02' } as const;

function fakeRuntime(identity: FabIdentity): FakeRuntime {
  return {
    siteId: identity.siteId,
    fabId: identity.fabId,
    start: vi.fn(),
    stop: vi.fn(),
  } as unknown as FakeRuntime;
}

it('resolves runtimes by complete (siteId, fabId) and leaves unknown identities unregistered', () => {
  const a = fakeRuntime(siteAFab01);
  const b = fakeRuntime(siteBFab01);
  const registry = new FabTelemetryRegistry();
  registry.replaceAll([a, b]);

  expect(registry.size).toBe(2);
  expect(registry.fabIdentities).toEqual([siteAFab01, siteBFab01].map(({ siteId, fabId }) => ({ siteId, fabId })));
  // Same fabId, different site: two independent runtimes, never a first match.
  expect(registry.get(siteAFab01)).toBe(a);
  expect(registry.get(siteBFab01)).toBe(b);
  expect(registry.get({ siteId: 'site-a', fabId: 'fab-99' })).toBeUndefined();
  expect(registry.get(undefined)).toBeUndefined();
  expect(a.start).not.toHaveBeenCalled();
  registry.disposeAll();
  expect(a.stop).toHaveBeenCalledOnce();
  expect(b.stop).toHaveBeenCalledOnce();
});

it('R5.4-03 T06/T07: acquiring Site A fab-01 starts only that runtime, and releasing its last consumer never stops Site B fab-01', () => {
  const a = fakeRuntime(siteAFab01);
  const b = fakeRuntime(siteBFab01);
  const registry = new FabTelemetryRegistry();
  registry.replaceAll([a, b]);

  // T06: acquire((site-a, fab-01)) must not start (site-b, fab-01).
  const releaseA = registry.acquire(siteAFab01);
  expect(a.start).toHaveBeenCalledTimes(1);
  expect(b.start).not.toHaveBeenCalled();

  // A Site B consumer shares the registry but owns its own independent stream.
  const releaseB = registry.acquire(siteBFab01);
  expect(b.start).toHaveBeenCalledTimes(1);
  expect(a.start).toHaveBeenCalledTimes(1);

  // T07: releasing the last Site A consumer stops only the Site A runtime.
  releaseA();
  expect(a.stop).toHaveBeenCalledTimes(1);
  expect(b.stop).not.toHaveBeenCalled();

  releaseB();
  expect(b.stop).toHaveBeenCalledTimes(1);
});

it('refcounts consumers per composite identity and makes duplicate releases idempotent', () => {
  const a = fakeRuntime(siteAFab01);
  const registry = new FabTelemetryRegistry();
  registry.replaceAll([a]);

  const releaseA = registry.acquire(siteAFab01);
  const releaseB = registry.acquire({ siteId: 'site-a', fabId: 'fab-01' });
  expect(a.start).toHaveBeenCalledTimes(1);
  // Another mounted consumer keeps the runtime live.
  releaseA();
  expect(a.stop).not.toHaveBeenCalled();
  releaseB();
  expect(a.stop).toHaveBeenCalledTimes(1);
  // Duplicate cleanup is a no-op and can never stop another generation.
  releaseB();
  expect(a.stop).toHaveBeenCalledTimes(1);
});

it('no-ops acquire/release for unregistered identities and ignores stale releases after replacement', () => {
  const first = fakeRuntime(siteAFab01);
  const second = fakeRuntime(siteAFab01);
  const registry = new FabTelemetryRegistry();
  registry.replaceAll([first]);

  const releaseOld = registry.acquire(siteAFab01);
  const releaseMissing = registry.acquire({ siteId: 'site-b', fabId: 'fab-01' });
  const releaseUndefined = registry.acquire(undefined);
  expect(() => { releaseMissing(); releaseUndefined(); }).not.toThrow();
  expect(first.start).toHaveBeenCalledTimes(1);

  registry.replaceAll([second]);
  expect(first.stop).toHaveBeenCalledTimes(1);
  // The old generation's cleanup must not stop the replacement runtime.
  releaseOld();
  expect(second.stop).not.toHaveBeenCalled();

  const releaseNew = registry.acquire(siteAFab01);
  expect(second.start).toHaveBeenCalledTimes(1);
  releaseNew();
  expect(second.stop).toHaveBeenCalledTimes(1);
});

it('survives a StrictMode mount/cleanup/remount lease cycle without leaking consumers', () => {
  const a = fakeRuntime(siteAFab01);
  const registry = new FabTelemetryRegistry();
  registry.replaceAll([a]);

  // React StrictMode runs every mount effect twice: acquire -> release -> acquire.
  const releaseFirst = registry.acquire(siteAFab01);
  releaseFirst();
  const releaseSecond = registry.acquire(siteAFab01);
  expect(a.start).toHaveBeenCalledTimes(2);
  expect(a.stop).toHaveBeenCalledTimes(1);

  releaseSecond();
  expect(a.stop).toHaveBeenCalledTimes(2);
});

it('R5.4-03 T12: same-site FABs keep independent runtimes, refcounts and stop lifetimes', () => {
  const fab01 = fakeRuntime(siteAFab01);
  const fab02 = fakeRuntime(siteBFab02);
  const registry = new FabTelemetryRegistry();
  registry.replaceAll([fab01, fab02]);

  const release01 = registry.acquire(siteAFab01);
  const release02 = registry.acquire(siteBFab02);
  expect(fab01.start).toHaveBeenCalledTimes(1);
  expect(fab02.start).toHaveBeenCalledTimes(1);

  release01();
  expect(fab01.stop).toHaveBeenCalledTimes(1);
  expect(fab02.stop).not.toHaveBeenCalled();

  release02();
  expect(fab02.stop).toHaveBeenCalledTimes(1);
});

it('stops replaced generation runtimes exactly once per identity and notifies listeners', () => {
  const firstA = fakeRuntime(siteAFab01);
  const firstB = fakeRuntime(siteBFab01);
  const nextA = fakeRuntime(siteAFab01);
  const registry = new FabTelemetryRegistry();
  const notifications: string[] = [];
  const unsubscribe = registry.subscribe(() => notifications.push('changed'));

  registry.replaceAll([firstA, firstB]);
  registry.replaceAll([nextA]);
  expect(firstA.stop).toHaveBeenCalledTimes(1);
  expect(firstB.stop).toHaveBeenCalledTimes(1);
  expect(registry.size).toBe(1);
  expect(registry.get(siteAFab01)).toBe(nextA);
  expect(registry.get(siteBFab01)).toBeUndefined();
  expect(notifications.length).toBe(2);

  unsubscribe();
  registry.replaceAll([]);
  expect(notifications.length).toBe(2);
  expect(nextA.stop).toHaveBeenCalledTimes(1);
  expect(registry.size).toBe(0);
  expect(registry.fabIdentities).toEqual([]);
});

it('clears consumer counts on disposeAll so stale releases cannot stop a later runtime', () => {
  const first = fakeRuntime(siteAFab01);
  const registry = new FabTelemetryRegistry();
  registry.replaceAll([first]);
  const release = registry.acquire(siteAFab01);

  registry.disposeAll();
  expect(first.stop).toHaveBeenCalledTimes(1);
  expect(registry.size).toBe(0);
  release();
  expect(first.stop).toHaveBeenCalledTimes(1);

  const second = fakeRuntime(siteAFab01);
  registry.replaceAll([second]);
  const releaseNew = registry.acquire(siteAFab01);
  expect(second.start).toHaveBeenCalledTimes(1);
  releaseNew();
  expect(second.stop).toHaveBeenCalledTimes(1);
});

it('keeps one consumer across a Runtime replaceAll while another unsubscribes from the old generation', () => {
  const first = fakeRuntime(siteAFab01);
  const second = fakeRuntime(siteAFab01);
  const registry = new FabTelemetryRegistry();
  registry.replaceAll([first]);

  const releaseA = registry.acquire(siteAFab01);
  const releaseB = registry.acquire(siteAFab01);
  expect(first.start).toHaveBeenCalledTimes(1);

  // One consumer unsubscribes while the other keeps streaming: the runtime stays.
  releaseA();
  expect(first.stop).not.toHaveBeenCalled();

  // A new runtime generation replaces the whole registry (e.g. telemetry provider
  // rebuild): the old runtime is stopped exactly once by the replacement.
  registry.replaceAll([second]);
  expect(first.stop).toHaveBeenCalledTimes(1);
  // Replaced runtimes are not started for consumers that no longer exist.
  expect(second.start).not.toHaveBeenCalled();

  // The old generation's late cleanup must not stop (or otherwise touch) the
  // replacement runtime, and duplicate releases stay idempotent.
  releaseB();
  releaseB();
  expect(second.stop).not.toHaveBeenCalled();

  // The replacement starts for its first current consumer and stops exactly once.
  const releaseNew = registry.acquire({ siteId: 'site-a', fabId: 'fab-01' });
  expect(second.start).toHaveBeenCalledTimes(1);
  releaseNew();
  releaseNew();
  expect(second.stop).toHaveBeenCalledTimes(1);
});
