import { afterEach, expect, it, vi } from 'vitest';
import { equipmentStatusDefinition, equipmentStatusKey } from '@/api/equipment.resource';
import { FAB_LAYOUT } from '@/domain/fab-layout';
import type { EquipmentStatusSnapshot } from '@/realtime/equipment-status.protocol';
import { createTestRuntime, type AppRuntime } from '../support/resource-test-runtime.tsx';

/**
 * CORE-003 (INV-03, G03/G04): a delayed REST response that loses the ordered
 * acceptance comparison must never write anything to the Atom — in particular it
 * can never write back the value captured when the request started.
 *
 * Baseline RED: 10 -> SSE 12 -> REST 11 rejected -> Atom was overwritten with 10.
 */
const scope = { siteId: 'site-1', fabId: 'fab-1' };
const frame = (sequence: number, state = 'running'): EquipmentStatusSnapshot => ({
  ...scope,
  generatedAt: '2026-10-27T00:00:0' + (sequence % 10) + 'Z',
  sequence,
  epoch: 1,
  tools: FAB_LAYOUT.map(() => ({ state })),
});
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
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

it('ignores a stale REST read instead of publishing the value captured at request start', async () => {
  const client = runtime();
  const manager = client.resources;
  const handle = manager.handle(equipmentStatusDefinition('site-1', 'fab-1'));

  expect(manager.publish(handle, frame(10), 'recovery')).toEqual({ _tag: 'Publish', value: frame(10) });
  expect(manager.value(handle)?.sequence).toBe(10);

  const rest = deferred<Response>();
  const fetchMock = vi.fn(() => rest.promise);
  vi.stubGlobal('fetch', fetchMock);
  const refresh = manager.refresh(handle);
  await expect.poll(() => fetchMock.mock.calls.length).toBe(1);
  expect(manager.stats.inFlight).toBe(1);

  // A newer accepted SSE snapshot arrives while the REST read is in flight.
  expect(manager.publish(handle, frame(12, 'maint'), 'push')).toEqual({ _tag: 'Publish', value: frame(12, 'maint') });

  rest.resolve(json(frame(11, 'idle')));
  // The load itself succeeds (11 is a valid wire frame); the commit rejects it.
  await refresh;
  expect(manager.value(handle)?.sequence, 'the rejected read must never write back 10').toBe(12);
  expect(manager.state(handle)._tag).toBe('Success');
  expect(manager.diagnostics.some((entry) => entry.reason === 'rejected' && entry.origin === 'read')).toBe(true);
});

it('rejects a duplicate or lower (epoch, sequence) push without writing the Atom', () => {
  const client = runtime();
  const manager = client.resources;
  const handle = manager.handle(equipmentStatusDefinition('site-1', 'fab-1'));

  expect(manager.publish(handle, frame(5), 'recovery')._tag).toBe('Publish');
  const writesBefore = manager.diagnostics.length;
  expect(manager.publish(handle, frame(5), 'push')).toEqual({ _tag: 'Ignore', reason: 'rejected' });
  expect(manager.publish(handle, frame(4), 'push')).toEqual({ _tag: 'Ignore', reason: 'rejected' });
  expect(manager.value(handle)?.sequence).toBe(5);
  expect(manager.diagnostics.length).toBeGreaterThan(writesBefore);

  // A restarted server generation outranks the previous sequence space.
  const restarted = { ...frame(1, 'down'), epoch: 2 };
  expect(manager.publish(handle, restarted as EquipmentStatusSnapshot, 'recovery')).toEqual({ _tag: 'Publish', value: restarted });
  expect(manager.value(handle)?.epoch).toBe(2);
  expect(manager.publish(handle, frame(999), 'push')).toEqual({ _tag: 'Ignore', reason: 'rejected' });
  expect(manager.value(handle)?.epoch).toBe(2);
});

it('has no second cache: a rejected candidate only changes bounded diagnostics', () => {
  const client = runtime();
  const manager = client.resources;
  const handle = manager.handle(equipmentStatusDefinition('site-1', 'fab-1'));
  manager.publish(handle, frame(3), 'recovery');
  const before = manager.value(handle);
  for (let index = 0; index < 100; index += 1) manager.publish(handle, frame(3), 'push');
  expect(manager.value(handle)).toBe(before);
  expect(manager.stats.entries).toBe(1);
  expect(manager.diagnostics.length).toBeLessThanOrEqual(32);
  // The FAB identity is part of the resource key: no cross-FAB second handle writes this Atom.
  expect(equipmentStatusKey('site-1', 'fab-1')).not.toBe(equipmentStatusKey('site-1', 'fab-2'));
});
