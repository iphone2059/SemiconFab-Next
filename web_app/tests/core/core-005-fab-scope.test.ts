import { afterEach, expect, it, vi } from 'vitest';
import { equipmentStatusDefinition, equipmentStatusKey } from '@/api/equipment.resource';
import { FAB_LAYOUT } from '@/domain/fab-layout';
import type { EquipmentStatusSnapshot } from '@/realtime/equipment-status.protocol';
import { createTestRuntime, type AppRuntime } from '../support/resource-test-runtime.tsx';

/**
 * CORE-005 (INV-03, G06): when the page hands over from FAB A to FAB B, a
 * REST/SSE callback that started under A must not write the new FAB Atom or the
 * new FAB's accepted ordering. FAB identity is part of the ResourceKey and the
 * old ResourceScope is closed, so a late callback is ignored.
 */
const frame = (fabId: string, sequence: number, state = 'running'): EquipmentStatusSnapshot => ({
  siteId: 'site-1',
  fabId,
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

it('a late FAB-A REST completion cannot modify FAB-B after the new scope activated', async () => {
  const client = runtime();
  const manager = client.resources;
  const fabA = equipmentStatusDefinition('site-1', 'fab-a');
  const fabB = equipmentStatusDefinition('site-1', 'fab-b');
  const handleA = manager.handle(fabA);
  const handleB = manager.handle(fabB);
  manager.publish(handleA, frame('fab-a', 5, 'down'), 'recovery');
  manager.publish(handleB, frame('fab-b', 1, 'running'), 'recovery');

  const rest = deferred<Response>();
  const fetchMock = vi.fn(() => rest.promise);
  vi.stubGlobal('fetch', fetchMock);
  const pendingA = manager.refresh(handleA);
  await expect.poll(() => fetchMock.mock.calls.length).toBe(1);

  // New FAB scope activated: FAB B publishes a newer accepted snapshot.
  manager.publish(handleB, frame('fab-b', 2, 'maint'), 'push');
  // Old FAB scope is released (the pipeline unmount closes its ResourceScope).
  manager.release(equipmentStatusKey('site-1', 'fab-a'));

  rest.resolve(json(frame('fab-a', 9, 'down')));
  await expect(pendingA).rejects.toBeDefined();

  expect(manager.value(handleB)?.sequence, 'new FAB Atom is untouched by old scope work').toBe(2);
  expect(manager.value(handleB)?.tools[0].state).toBe('maint');
  // FAB identities never share an Atom: the released A entry is gone, B stays.
  expect(manager.stats.entries).toBe(1);
});

it('FAB identity is part of the canonical resource key (no state sharing)', () => {
  const client = runtime();
  const manager = client.resources;
  const a = manager.handle(equipmentStatusDefinition('site-1', 'fab-a'));
  const b = manager.handle(equipmentStatusDefinition('site-1', 'fab-b'));
  expect(a.atom).not.toBe(b.atom);
  expect(a.key).not.toBe(b.key);
  manager.publish(a, frame('fab-a', 9), 'recovery');
  manager.publish(b, frame('fab-b', 1), 'recovery');
  expect(manager.value(a)?.sequence).toBe(9);
  expect(manager.value(b)?.sequence).toBe(1);
});
