import { Effect } from 'effect';
import { afterEach, expect, it, vi } from 'vitest';
import { defineResource } from '@/api/resource';
import { equipmentStatusDefinition } from '@/api/equipment.resource';
import { FAB_LAYOUT } from '@/domain/fab-layout';
import type { EquipmentStatusSnapshot } from '@/realtime/equipment-status.protocol';
import { createTestRuntime, type AppRuntime } from '../../support/resource-test-runtime.tsx';

/**
 * 矩阵 5 / CR-05 (ADR-013 §1.1): a delayed generic GET must not overwrite a newer
 * accepted mutation/recovery publish. Accept-capable resources keep their own
 * ordered-acceptance semantics (device epoch/sequence must not regress).
 */
const runtimes: AppRuntime<never>[] = [];
const runtime = (): AppRuntime<never> => {
  const value = createTestRuntime();
  runtimes.push(value);
  return value;
};
afterEach(async () => {
  for (const value of runtimes.splice(0)) await value.dispose();
  vi.unstubAllGlobals();
});

interface Gate<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}
const deferred = <T,>(): Gate<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

/** A generic resource whose loads are resolved manually, in request order. */
const controlledGenericDefinition = (pending: Array<Gate<string>>) => defineResource({
  identity: { kind: 'generic-controlled', version: 1, key: 'generic-controlled' },
  load: Effect.suspend(() => {
    const gate = deferred<string>();
    pending.push(gate);
    return Effect.tryPromise({ try: () => gate.promise, catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)) });
  }),
  policy: { freshnessMs: 0, idleTtlMs: 300_000 },
});

it('ignores a generic GET that started before an accepted mutation publish', async () => {
  const client = runtime();
  const manager = client.resources;
  const pending: Array<Gate<string>> = [];
  const handle = manager.handle(controlledGenericDefinition(pending));

  const get = manager.refresh(handle);
  await expect.poll(() => pending.length).toBe(1);
  expect(manager.publish(handle, 'mutation-new', 'mutation')).toEqual({ _tag: 'Publish', value: 'mutation-new' });

  pending[0].resolve('get-old');
  await expect(get).resolves.toBe('get-old');
  expect(manager.value(handle), 'old GET must not overwrite the accepted mutation').toBe('mutation-new');
  expect(manager.diagnostics.some((entry) => entry.origin === 'read' && entry.reason === 'superseded-write')).toBe(true);
  expect(manager.stats.inFlight).toBe(0);
});

it('ignores a generic GET that started before an accepted recovery publish', async () => {
  const client = runtime();
  const manager = client.resources;
  const pending: Array<Gate<string>> = [];
  const handle = manager.handle(controlledGenericDefinition(pending));
  const get = manager.refresh(handle);
  await expect.poll(() => pending.length).toBe(1);
  expect(manager.publish(handle, 'recovery-new', 'recovery')._tag).toBe('Publish');
  pending[0].resolve('get-old');
  await get;
  expect(manager.value(handle)).toBe('recovery-new');
  expect(manager.diagnostics.some((entry) => entry.reason === 'superseded-write')).toBe(true);
});

it('a superseded generic read failure only produces a diagnostic (no Atom write)', async () => {
  const client = runtime();
  const manager = client.resources;
  const pending: Array<Gate<string>> = [];
  const handle = manager.handle(controlledGenericDefinition(pending));
  const get = manager.refresh(handle);
  await expect.poll(() => pending.length).toBe(1);
  manager.publish(handle, 'recovery-new', 'recovery');
  pending[0].reject(new Error('boom'));
  await expect(get).rejects.toThrow('boom');
  expect(manager.state(handle)._tag).toBe('Success');
  expect(manager.value(handle)).toBe('recovery-new');
  expect(manager.diagnostics.some((entry) => entry.origin === 'read' && entry.reason === 'superseded-write')).toBe(true);
});

it('keeps equipment epoch/sequence acceptance (accept-capable resource decides, not the generic rule)', async () => {
  const client = runtime();
  const manager = client.resources;
  const scope = { siteId: 'site-1', fabId: 'fab-1' };
  const frame = (sequence: number, state = 'running'): EquipmentStatusSnapshot => ({
    ...scope,
    generatedAt: '2026-10-30T00:00:0' + (sequence % 10) + 'Z',
    sequence,
    epoch: 1,
    tools: FAB_LAYOUT.map(() => ({ state })),
  });
  const handle = manager.handle(equipmentStatusDefinition('site-1', 'fab-1'));
  manager.publish(handle, frame(10), 'recovery');
  const rest = deferred<Response>();
  const fetchMock = vi.fn(() => rest.promise);
  vi.stubGlobal('fetch', fetchMock);
  const refresh = manager.refresh(handle);
  await expect.poll(() => fetchMock.mock.calls.length).toBe(1);
  manager.publish(handle, frame(12, 'maint'), 'push');
  rest.resolve(new Response(JSON.stringify(frame(11, 'idle')), { status: 200, headers: { 'content-type': 'application/json' } }));
  await refresh;
  expect(manager.value(handle)?.sequence, 'accept protocol still rejects the older REST frame').toBe(12);
  expect(manager.diagnostics.some((entry) => entry.reason === 'rejected')).toBe(true);
});

it('keeps generic resources isolated per AppRuntime', async () => {
  const pendingA: Array<Gate<string>> = [];
  const pendingB: Array<Gate<string>> = [];
  const clientA = runtime();
  const clientB = runtime();
  const handleA = clientA.resources.handle(controlledGenericDefinition(pendingA));
  const handleB = clientB.resources.handle(controlledGenericDefinition(pendingB));
  const getA = clientA.resources.refresh(handleA);
  const getB = clientB.resources.refresh(handleB);
  await expect.poll(() => pendingA.length + pendingB.length).toBe(2);
  clientB.resources.publish(handleB, 'b-new', 'mutation');
  pendingB[0].resolve('b-old');
  pendingA[0].resolve('a-old');
  await Promise.all([getA, getB]);
  expect(clientA.resources.value(handleA), 'runtime A keeps its own read').toBe('a-old');
  expect(clientB.resources.value(handleB), 'runtime B keeps its own mutation').toBe('b-new');
});
