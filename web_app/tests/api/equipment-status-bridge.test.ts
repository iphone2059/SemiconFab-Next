import { afterEach, expect, it, vi } from 'vitest';
import { equipmentStatusDefinition } from '@/api/equipment.resource';
import { FAB_LAYOUT } from '@/domain/fab-layout';
import type { EquipmentStatusSnapshot } from '@/realtime/equipment-status.protocol';
import { createTestRuntime, type AppRuntime } from '../support/resource-test-runtime.tsx';

/**
 * Equipment status single commit port (ADR-006 §2.5): REST, SSE pushes, reconnect
 * snapshots and recovery snapshots all commit through the manager's ordered
 * accept hook. The accepted (epoch, sequence) high-water is read from the resource
 * Atom inside the same synchronous commit step — there is no second gate object.
 */
const scopeA = { siteId: 'site-a', fabId: 'fab-1' };
const foreignScope = { siteId: 'site-a', fabId: 'unknown-fab' };
const tools = (state = 'running') => FAB_LAYOUT.map(() => ({ state }));
const frame = (
  scope: { siteId: string; fabId: string },
  sequence: number,
  generatedAt: string,
  patch: Partial<EquipmentStatusSnapshot> = {},
): EquipmentStatusSnapshot => ({
  siteId: scope.siteId,
  fabId: scope.fabId,
  generatedAt,
  sequence,
  epoch: 1,
  tools: tools(),
  ...patch,
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

const accepted = (client: AppRuntime<never>, scope: { siteId: string; fabId: string }) => {
  const manager = client.resources;
  return manager.value(manager.handle(equipmentStatusDefinition(scope.siteId, scope.fabId)));
};

it('accepts round-order snapshots and rejects duplicates/lower sequences without writing', () => {
  const client = runtime();
  const manager = client.resources;
  const handle = manager.handle(equipmentStatusDefinition(scopeA.siteId, scopeA.fabId));
  expect(manager.publish(handle, frame(scopeA, 5, '2026-10-27T00:00:05Z'), 'recovery')._tag).toBe('Publish');
  expect(accepted(client, scopeA)?.sequence).toBe(5);
  expect(manager.publish(handle, frame(scopeA, 4, '2026-10-27T00:00:04Z'), 'push')).toEqual({ _tag: 'Ignore', reason: 'rejected' });
  expect(manager.publish(handle, frame(scopeA, 5, '2026-10-27T00:00:09Z'), 'push')).toEqual({ _tag: 'Ignore', reason: 'rejected' });
  expect(accepted(client, scopeA)?.sequence).toBe(5);
  expect(manager.publish(handle, frame(scopeA, 6, '2026-10-27T00:00:06Z'), 'push')._tag).toBe('Publish');
  expect(accepted(client, scopeA)?.sequence).toBe(6);
});

it('a restarted server epoch outranks the previous sequence space, and late old-epoch frames die', () => {
  const client = runtime();
  const manager = client.resources;
  const handle = manager.handle(equipmentStatusDefinition(scopeA.siteId, scopeA.fabId));
  manager.publish(handle, frame(scopeA, 5, '2026-10-27T00:00:05Z'), 'recovery');
  const restarted = frame(scopeA, 1, '2026-10-27T00:00:10Z', { epoch: 2, tools: tools('down') });
  expect(manager.publish(handle, restarted, 'recovery')).toEqual({ _tag: 'Publish', value: restarted });
  const late = frame(scopeA, 999, '2026-10-27T00:00:09Z', { tools: tools('maint') });
  expect(manager.publish(handle, late, 'push')).toEqual({ _tag: 'Ignore', reason: 'rejected' });
  expect(accepted(client, scopeA)).toEqual(restarted);
});

it('a delayed REST response cannot regress a newer accepted SSE snapshot', async () => {
  const client = runtime();
  const manager = client.resources;
  const handle = manager.handle(equipmentStatusDefinition(scopeA.siteId, scopeA.fabId));
  manager.publish(handle, frame(scopeA, 10, '2026-10-27T00:00:10Z'), 'recovery');
  const rest = deferred<Response>();
  const fetchMock = vi.fn(() => rest.promise);
  vi.stubGlobal('fetch', fetchMock);
  const refresh = manager.refresh(handle);
  await expect.poll(() => fetchMock.mock.calls.length).toBe(1);
  const sse = frame(scopeA, 12, '2026-10-27T00:00:12Z', { tools: tools('maint') });
  expect(manager.publish(handle, sse, 'push')._tag).toBe('Publish');
  rest.resolve(json(frame(scopeA, 11, '2026-10-27T00:00:11Z', { tools: tools('idle') })));
  await refresh;
  expect(accepted(client, scopeA)).toEqual(sse);
  expect(manager.diagnostics.some((entry) => entry.reason === 'rejected')).toBe(true);
});

it('rejects missing fields, wrong tool counts and foreign FAB identities as diagnostics only', () => {
  const client = runtime();
  const manager = client.resources;
  const handle = manager.handle(equipmentStatusDefinition(scopeA.siteId, scopeA.fabId));
  const invalid: unknown[] = [
    { ...frame(scopeA, 1, 'x'), tools: tools().slice(0, 3) },
    { siteId: scopeA.siteId, fabId: scopeA.fabId, generatedAt: 'x', sequence: 2, epoch: 1 },
    frame(foreignScope, 3, 'x'),
  ];
  for (const candidate of invalid) {
    expect(manager.publish(handle, candidate as EquipmentStatusSnapshot, 'push')).toEqual({ _tag: 'Ignore', reason: 'rejected' });
  }
  expect(accepted(client, scopeA)).toBeUndefined();
  expect(manager.diagnostics.filter((entry) => entry.reason === 'rejected')).toHaveLength(3);
});

it('accepts and retains a large valid frame without a second cache', () => {
  const client = runtime();
  const manager = client.resources;
  const handle = manager.handle(equipmentStatusDefinition(scopeA.siteId, scopeA.fabId));
  const large = frame(scopeA, 5000, '2026-10-27T00:05:00Z', {
    tools: FAB_LAYOUT.map((_, index) => ({ state: index % 2 ? 'running' : 'down' })),
  });
  expect(manager.publish(handle, large, 'recovery')).toEqual({ _tag: 'Publish', value: large });
  expect(accepted(client, scopeA)).toEqual(large);
  expect(manager.stats.entries).toBe(1);
});
