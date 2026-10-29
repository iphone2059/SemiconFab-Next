import { afterEach, expect, it, vi } from 'vitest';
import * as AsyncResult from 'effect/reactivity/AsyncResult';
import { equipmentStatusDefinition } from '@/api/equipment.resource';
import { FAB_LAYOUT } from '@/domain/fab-layout';
import type { EquipmentStatusSnapshot } from '@/realtime/equipment-status.protocol';
import { createTestRuntime, type AppRuntime } from '../support/resource-test-runtime.tsx';

/**
 * CORE-004 (INV-03): a failed REST read that started before an SSE snapshot was
 * accepted must only produce a diagnostic. It must never replace the accepted
 * success with Failure / the captured previous value.
 */
const scope = { siteId: 'site-1', fabId: 'fab-1' };
const frame = (sequence: number, state = 'running'): EquipmentStatusSnapshot => ({
  ...scope,
  generatedAt: '2026-10-27T00:00:0' + (sequence % 10) + 'Z',
  sequence,
  epoch: 1,
  tools: FAB_LAYOUT.map(() => ({ state })),
});
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

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

it('a stale REST failure after an accepted SSE push keeps the success and records a diagnostic', async () => {
  const client = runtime();
  const manager = client.resources;
  const handle = manager.handle(equipmentStatusDefinition('site-1', 'fab-1'));
  manager.publish(handle, frame(10), 'recovery');

  const rest = deferred<Response>();
  const fetchMock = vi.fn(() => rest.promise);
  vi.stubGlobal('fetch', fetchMock);
  const refresh = manager.refresh(handle);
  await expect.poll(() => fetchMock.mock.calls.length).toBe(1);
  manager.publish(handle, frame(12, 'maint'), 'push');

  rest.resolve(new Response('gateway down', { status: 502 }));
  await expect(refresh).rejects.toThrow(/HTTP 502/);

  const state = manager.state(handle);
  expect(AsyncResult.isFailure(state), 'a stale failure must not overwrite the accepted success').toBe(false);
  expect(manager.value(handle)?.sequence).toBe(12);
  expect(AsyncResult.isSuccess(state) && state.waiting).toBe(false);
  expect(manager.diagnostics.some((entry) => entry.reason === 'superseded-write')).toBe(true);
});

it('a current failed read keeps the previous success inside the same AsyncResult (no data loss)', async () => {
  const client = runtime();
  const manager = client.resources;
  const handle = manager.handle(equipmentStatusDefinition('site-1', 'fab-1'));
  manager.publish(handle, frame(7), 'recovery');

  const rest = deferred<Response>();
  vi.stubGlobal('fetch', vi.fn(() => rest.promise));
  const refresh = manager.refresh(handle);
  rest.resolve(new Response('boom', { status: 503 }));
  await expect(refresh).rejects.toThrow(/HTTP 503/);

  const state = manager.state(handle);
  expect(AsyncResult.isFailure(state)).toBe(true);
  expect(manager.value(handle)?.sequence, 'previousSuccess stays the same-Atom value').toBe(7);
  if (AsyncResult.isFailure(state)) {
    expect(state.previousSuccess._tag).toBe('Some');
    expect(state.previousSuccess._tag === 'Some' ? state.previousSuccess.value.value.sequence : -1).toBe(7);
  }
  // A later accepted SSE frame recovers the ready state through the same commit port.
  expect(manager.publish(handle, frame(8, 'down'), 'push')).toEqual({ _tag: 'Publish', value: frame(8, 'down') });
  expect(manager.state(handle)._tag).toBe('Success');
  expect(manager.value(handle)?.sequence).toBe(8);
});
