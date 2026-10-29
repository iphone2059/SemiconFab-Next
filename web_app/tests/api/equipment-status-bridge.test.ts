import { expect, it } from 'vitest';
import {
  acceptEquipmentStatusSnapshot,
  activateEquipmentStatusScope,
  equipmentStatusGate,
  equipmentStatusResource,
  resetEquipmentStatusGates,
} from '@/api/equipment.resource';
import { resourceValue } from '@/api/resource';
import { FAB_LAYOUT } from '@/domain/fab-layout';
import type { EquipmentStatusSnapshot } from '@/realtime/equipment-status.protocol';
import { createTestRuntime } from '../support/resource-test-runtime.tsx';

/**
 * The per-registry ordering gate is the single acceptance boundary for REST and
 * SSE snapshots. These tests pin the cross-boundary races the plan requires:
 * same-FAB reactivation, a late callback from an old epoch, duplicate
 * epoch/sequence after an SSE reconnect, REST/SSE reordering, missing fields and
 * a large frame. The resource Atom is the only accepted-snapshot store.
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

const accepted = (runtime: ReturnType<typeof createTestRuntime>, scope: { siteId: string; fabId: string }) =>
  resourceValue(runtime.registry, equipmentStatusResource(scope.siteId, scope.fabId));

it('reactivating the same FAB seeds its ordering high-water from the accepted resource Atom', () => {
  const runtime = createTestRuntime();
  activateEquipmentStatusScope(runtime.registry, scopeA);
  expect(acceptEquipmentStatusSnapshot(runtime, scopeA, frame(scopeA, 5, '2026-10-27T00:00:05Z'))?.sequence).toBe(5);
  expect(equipmentStatusGate(runtime.registry, scopeA)).toBe(equipmentStatusGate(runtime.registry, scopeA));

  const previousGate = equipmentStatusGate(runtime.registry, scopeA);
  // A fresh page activation keeps the Atom's accepted history.
  activateEquipmentStatusScope(runtime.registry, scopeA);
  expect(equipmentStatusGate(runtime.registry, scopeA)).not.toBe(previousGate);
  expect(acceptEquipmentStatusSnapshot(runtime, scopeA, frame(foreignScope, 9, '2026-10-27T00:00:09Z'))).toBeUndefined();
  expect(acceptEquipmentStatusSnapshot(runtime, scopeA, frame(scopeA, 4, '2026-10-27T00:00:04Z'))).toBeUndefined();
  expect(acceptEquipmentStatusSnapshot(runtime, scopeA, frame(scopeA, 6, '2026-10-27T00:00:06Z'))?.sequence).toBe(6);
  expect(accepted(runtime, scopeA)?.sequence).toBe(6);
  runtime.dispose();
});

it('a late callback from the previous epoch cannot pollute the reactivated FAB Atom', () => {
  const runtime = createTestRuntime();
  activateEquipmentStatusScope(runtime.registry, scopeA);
  expect(acceptEquipmentStatusSnapshot(runtime, scopeA, frame(scopeA, 5, '2026-10-27T00:00:05Z'))?.sequence).toBe(5);
  activateEquipmentStatusScope(runtime.registry, scopeA);
  const restarted = frame(scopeA, 1, '2026-10-27T00:00:10Z', { epoch: 2, tools: tools('down') });
  expect(acceptEquipmentStatusSnapshot(runtime, scopeA, restarted)).toEqual(restarted);
  const late = frame(scopeA, 9, '2026-10-27T00:00:09Z', { tools: tools('maint') });
  expect(acceptEquipmentStatusSnapshot(runtime, scopeA, late)).toBeUndefined();
  expect(accepted(runtime, scopeA)).toEqual(restarted);
  runtime.dispose();
});

it('a reconnected SSE stream replaying the same epoch/sequence is a duplicate, not an Atom write', () => {
  const runtime = createTestRuntime();
  activateEquipmentStatusScope(runtime.registry, scopeA);
  const first = frame(scopeA, 7, '2026-10-27T00:00:07Z');
  expect(acceptEquipmentStatusSnapshot(runtime, scopeA, first)?.sequence).toBe(7);
  expect(acceptEquipmentStatusSnapshot(runtime, scopeA, first)).toBeUndefined();
  expect(accepted(runtime, scopeA)).toEqual(first);
  runtime.dispose();
});

it('a delayed REST response cannot regress a newer accepted SSE Atom value', () => {
  const runtime = createTestRuntime();
  activateEquipmentStatusScope(runtime.registry, scopeA);
  const sse = frame(scopeA, 12, '2026-10-27T00:00:12Z', { tools: tools('maint') });
  expect(acceptEquipmentStatusSnapshot(runtime, scopeA, sse)).toEqual(sse);
  const delayedRest = frame(scopeA, 11, '2026-10-27T00:00:11Z', { tools: tools('idle') });
  expect(acceptEquipmentStatusSnapshot(runtime, scopeA, delayedRest)).toBeUndefined();
  expect(accepted(runtime, scopeA)).toEqual(sse);
  runtime.dispose();
});

it('rejects missing fields, wrong tool counts and foreign FAB identities through onInvalid', () => {
  const runtime = createTestRuntime();
  let invalid = 0;
  activateEquipmentStatusScope(runtime.registry, scopeA, () => { invalid += 1; });
  expect(acceptEquipmentStatusSnapshot(runtime, scopeA, { ...frame(scopeA, 1, 'x'), tools: tools().slice(0, 3) })).toBeUndefined();
  expect(acceptEquipmentStatusSnapshot(runtime, scopeA, { siteId: scopeA.siteId, fabId: scopeA.fabId, generatedAt: 'x', sequence: 2, epoch: 1 })).toBeUndefined();
  expect(acceptEquipmentStatusSnapshot(runtime, scopeA, frame(foreignScope, 3, 'x'))).toBeUndefined();
  expect(invalid).toBe(3);
  expect(accepted(runtime, scopeA)).toBeUndefined();
  runtime.dispose();
});

it('accepts and retains a large valid frame without a second cache', () => {
  const runtime = createTestRuntime();
  activateEquipmentStatusScope(runtime.registry, scopeA);
  const large = frame(scopeA, 5000, '2026-10-27T00:05:00Z', { tools: FAB_LAYOUT.map((_, index) => ({ state: index % 2 ? 'running' : 'down' })) });
  expect(acceptEquipmentStatusSnapshot(runtime, scopeA, large)).toEqual(large);
  expect(accepted(runtime, scopeA)).toEqual(large);
  resetEquipmentStatusGates(runtime.registry);
  runtime.dispose();
});
