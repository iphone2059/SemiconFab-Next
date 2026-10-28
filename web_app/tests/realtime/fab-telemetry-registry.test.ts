import { expect, it, vi } from 'vitest';
import { FabTelemetryRegistry } from '../../src/realtime/telemetry/FabTelemetryRegistry';
import type { TelemetryRuntime } from '../../src/realtime/telemetry/TelemetryRuntime';

type FakeRuntime = TelemetryRuntime & { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };

function fakeRuntime(fabId: string): FakeRuntime {
  return { fabId, start: vi.fn(), stop: vi.fn() } as unknown as FakeRuntime;
}

it('resolves the configured FAB runtime and leaves unknown identities unregistered', () => {
  const runtime = fakeRuntime('fab-a');
  const registry = new FabTelemetryRegistry();
  registry.replaceAll(new Map([['fab-a', runtime]]));
  expect(registry.size).toBe(1);
  expect(registry.fabIds).toEqual(['fab-a']);
  expect(registry.get('fab-a')).toBe(runtime);
  expect(registry.get('missing')).toBeUndefined();
  expect(registry.get(undefined)).toBeUndefined();
  expect(runtime.start).not.toHaveBeenCalled();
  registry.disposeAll();
  expect(runtime.stop).toHaveBeenCalledOnce();
});

it('stops replaced and disposed runtimes exactly once', () => {
  const first = fakeRuntime('fab-a');
  const second = fakeRuntime('fab-a');
  const registry = new FabTelemetryRegistry();
  registry.replaceAll(new Map([['fab-a', first]]));
  registry.replaceAll(new Map([['fab-a', second]]));
  expect(first.stop).toHaveBeenCalledTimes(1);
  registry.disposeAll();
  expect(second.stop).toHaveBeenCalledTimes(1);
  expect(registry.size).toBe(0);
  expect(registry.fabIds).toEqual([]);
});

it('starts on the first acquire and stops only when the last consumer releases', () => {
  const runtime = fakeRuntime('fab-a');
  const registry = new FabTelemetryRegistry();
  registry.replaceAll(new Map([['fab-a', runtime]]));

  const releaseA = registry.acquire('fab-a');
  const releaseB = registry.acquire('fab-a');
  expect(runtime.start).toHaveBeenCalledTimes(1);
  // Equipment runtime still has another mounted consumer: do not stop it.
  releaseA();
  expect(runtime.stop).not.toHaveBeenCalled();
  releaseB();
  expect(runtime.stop).toHaveBeenCalledTimes(1);
  // Duplicate cleanup releases are idempotent and never stop twice.
  releaseB();
  expect(runtime.stop).toHaveBeenCalledTimes(1);
});

it('no-ops acquire/release for unregistered FABs and ignores stale releases after replacement', () => {
  const first = fakeRuntime('fab-a');
  const second = fakeRuntime('fab-a');
  const registry = new FabTelemetryRegistry();
  registry.replaceAll(new Map([['fab-a', first]]));

  const releaseOld = registry.acquire('fab-a');
  const releaseMissing = registry.acquire('missing');
  const releaseUndefined = registry.acquire(undefined);
  expect(() => { releaseMissing(); releaseUndefined(); }).not.toThrow();
  expect(first.start).toHaveBeenCalledTimes(1);

  registry.replaceAll(new Map([['fab-a', second]]));
  expect(first.stop).toHaveBeenCalledTimes(1);
  // The old generation's cleanup must not stop the replacement runtime.
  releaseOld();
  expect(second.stop).not.toHaveBeenCalled();

  const releaseNew = registry.acquire('fab-a');
  expect(second.start).toHaveBeenCalledTimes(1);
  releaseNew();
  expect(second.stop).toHaveBeenCalledTimes(1);
});

it('survives a StrictMode mount/cleanup/remount lease cycle without leaking consumers', () => {
  const runtime = fakeRuntime('fab-a');
  const registry = new FabTelemetryRegistry();
  registry.replaceAll(new Map([['fab-a', runtime]]));

  // React StrictMode runs every mount effect twice: acquire -> release -> acquire.
  const releaseFirst = registry.acquire('fab-a');
  releaseFirst();
  const releaseSecond = registry.acquire('fab-a');
  expect(runtime.start).toHaveBeenCalledTimes(2);
  expect(runtime.stop).toHaveBeenCalledTimes(1);

  // The remounted consumer still owns the lease: only its release stops the runtime.
  releaseSecond();
  expect(runtime.stop).toHaveBeenCalledTimes(2);
});

it('clears consumer counts on disposeAll so stale releases cannot stop a later runtime', () => {
  const first = fakeRuntime('fab-a');
  const registry = new FabTelemetryRegistry();
  registry.replaceAll(new Map([['fab-a', first]]));
  const release = registry.acquire('fab-a');

  registry.disposeAll();
  expect(first.stop).toHaveBeenCalledTimes(1);
  expect(registry.size).toBe(0);
  release();
  expect(first.stop).toHaveBeenCalledTimes(1);

  const second = fakeRuntime('fab-a');
  registry.replaceAll(new Map([['fab-a', second]]));
  const releaseNew = registry.acquire('fab-a');
  expect(second.start).toHaveBeenCalledTimes(1);
  releaseNew();
  expect(second.stop).toHaveBeenCalledTimes(1);
});

it('two consumers survive one unsubscribe across a Runtime replaceAll with idempotent releases', () => {
  const first = fakeRuntime('fab-a');
  const second = fakeRuntime('fab-a');
  const registry = new FabTelemetryRegistry();
  registry.replaceAll(new Map([['fab-a', first]]));

  const releaseA = registry.acquire('fab-a');
  const releaseB = registry.acquire('fab-a');
  expect(first.start).toHaveBeenCalledTimes(1);

  // One consumer unsubscribes while the other keeps streaming: the runtime stays.
  releaseA();
  expect(first.stop).not.toHaveBeenCalled();

  // A new runtime generation replaces the whole registry (e.g. telemetry provider
  // rebuild): the old runtime is stopped exactly once by the replacement.
  registry.replaceAll(new Map([['fab-a', second]]));
  expect(first.stop).toHaveBeenCalledTimes(1);
  // Replaced runtimes are not started for consumers that no longer exist.
  expect(second.start).not.toHaveBeenCalled();

  // The old generation's late cleanup must not stop (or otherwise touch) the
  // replacement runtime, and duplicate releases stay idempotent.
  releaseB();
  releaseB();
  expect(second.stop).not.toHaveBeenCalled();

  // The replacement starts for its first current consumer and stops exactly once.
  const releaseNew = registry.acquire('fab-a');
  expect(second.start).toHaveBeenCalledTimes(1);
  releaseNew();
  releaseNew();
  expect(second.stop).toHaveBeenCalledTimes(1);
});
