import { QueryClient } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import {
  acceptEquipmentStatusSnapshot,
  activateEquipmentStatusScope,
  equipmentStatusGate,
  resetEquipmentStatusGates,
} from '../../src/api/cache/equipment-status-bridge';
import { equipmentStatusQueryKey, equipmentStatusQueryOptions } from '../../src/api/queries/equipment.queries';
import { FAB_LAYOUT } from '../../src/domain/fab/fab-layout';
import type { EquipmentStatusSnapshot } from '../../src/realtime/equipment-status/protocol';

/**
 * The Query-cache projection bridge is the single acceptance boundary for REST
 * and SSE snapshots. These tests pin the cross-boundary races the plan requires:
 * FAB A→B→A isolation, a late callback from an old scope activation, duplicate
 * epoch/sequence after an SSE reconnect, REST/SSE reordering, missing fields and
 * a large frame. The Query cache itself stays the only accepted-snapshot store.
 */

const scopeA = { siteId: 'site-a', fabId: 'fab-1' };
const scopeB = { siteId: 'site-a', fabId: 'fab-2' };
const keyA = equipmentStatusQueryKey(scopeA.siteId, scopeA.fabId);
const keyB = equipmentStatusQueryKey(scopeB.siteId, scopeB.fabId);
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

const freshClient = () => new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
const jsonResponse = (value: unknown) =>
  new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

it('A→B→A keeps the Query cache and the ordering high-water isolated per FAB', () => {
  const client = freshClient();
  activateEquipmentStatusScope(client, scopeA);
  expect(acceptEquipmentStatusSnapshot(client, scopeA, frame(scopeA, 5, '2026-10-27T00:00:05Z'))?.sequence).toBe(5);
  // The scope gate resolution is stable for one activation generation.
  expect(equipmentStatusGate(client, scopeA)).toBe(equipmentStatusGate(client, scopeA));

  activateEquipmentStatusScope(client, scopeB);
  // B starts its own ordering history: a low sequence of the other FAB is fine.
  expect(acceptEquipmentStatusSnapshot(client, scopeB, frame(scopeB, 1, '2026-10-27T00:00:01Z', { tools: tools('down') }))?.sequence).toBe(1);
  // A frame sent to B's scope never writes B's cache nor advances A's gate.
  expect(acceptEquipmentStatusSnapshot(client, scopeB, frame(scopeA, 9, '2026-10-27T00:00:09Z'))).toBeUndefined();
  expect(client.getQueryData<EquipmentStatusSnapshot>(keyA)?.sequence).toBe(5);
  expect(client.getQueryData<EquipmentStatusSnapshot>(keyB)?.sequence).toBe(1);

  // Back to A: re-activation seeds the new gate from the accepted cache entry, so
  // the return visit cannot roll the FAB back to an older frame.
  activateEquipmentStatusScope(client, scopeA);
  expect(acceptEquipmentStatusSnapshot(client, scopeA, frame(scopeA, 4, '2026-10-27T00:00:04Z'))).toBeUndefined();
  expect(acceptEquipmentStatusSnapshot(client, scopeA, frame(scopeA, 6, '2026-10-27T00:00:06Z'))?.sequence).toBe(6);
  expect(client.getQueryData<EquipmentStatusSnapshot>(keyA)?.sequence).toBe(6);
  // B's re-entry is independent of A's advance.
  activateEquipmentStatusScope(client, scopeB);
  expect(acceptEquipmentStatusSnapshot(client, scopeB, frame(scopeB, 2, '2026-10-27T00:00:02Z'))?.sequence).toBe(2);
  expect(client.getQueryData<EquipmentStatusSnapshot>(keyB)?.sequence).toBe(2);
  expect(client.getQueryData<EquipmentStatusSnapshot>(keyA)?.sequence).toBe(6);
});

it('a late callback from the previous scope activation cannot pollute the new FAB', () => {
  const client = freshClient();
  activateEquipmentStatusScope(client, scopeA);
  activateEquipmentStatusScope(client, scopeB);
  // The A SSE listener fires once more after the page switched to B (its abort
  // raced with the frame); the composite scope token routes it to A's cache only.
  const lateA = frame(scopeA, 9, '2026-10-27T00:00:09Z', { tools: tools('maint') });
  expect(acceptEquipmentStatusSnapshot(client, scopeA, lateA)?.sequence).toBe(9);
  expect(client.getQueryData(keyB)).toBeUndefined();
  // B's fresh ordering history was not advanced by A's high-water mark.
  expect(acceptEquipmentStatusSnapshot(client, scopeB, frame(scopeB, 1, '2026-10-27T00:00:01Z'))?.sequence).toBe(1);
});

it('a reconnected SSE stream replaying the same epoch/sequence is a duplicate, not a cache write', () => {
  const client = freshClient();
  const onInvalid = vi.fn();
  activateEquipmentStatusScope(client, scopeA, onInvalid);
  const accepted = frame(scopeA, 3, '2026-10-27T00:00:03Z', { tools: tools('down') });
  expect(acceptEquipmentStatusSnapshot(client, scopeA, accepted)?.sequence).toBe(3);

  // Reconnect replay + an older frame of the same generation: both rejected.
  expect(acceptEquipmentStatusSnapshot(client, scopeA, { ...accepted })).toBeUndefined();
  expect(acceptEquipmentStatusSnapshot(client, scopeA, frame(scopeA, 2, '2026-10-27T00:00:02Z', { tools: tools('maint') }))).toBeUndefined();
  expect(client.getQueryData<EquipmentStatusSnapshot>(keyA)?.tools[0].state).toBe('down');
  // Ordering rejections are not malformed data: the stream is not marked stale.
  expect(onInvalid).not.toHaveBeenCalled();

  // Backend restart bumps the epoch: its restarted sequence is accepted.
  expect(acceptEquipmentStatusSnapshot(client, scopeA, frame(scopeA, 1, '2026-10-27T00:00:10Z', { epoch: 2, tools: tools('idle') }))?.epoch).toBe(2);
  // A late frame from the pre-restart generation is dropped.
  expect(acceptEquipmentStatusSnapshot(client, scopeA, frame(scopeA, 4, '2026-10-27T00:00:11Z', { epoch: 1 }))).toBeUndefined();
  expect(client.getQueryData<EquipmentStatusSnapshot>(keyA)?.epoch).toBe(2);
});

it('a REST poll resolving after a newer SSE frame cannot regress the cache', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(frame(scopeA, 4, '2026-10-27T00:00:04Z', { tools: tools('maint') }))));
  const client = freshClient();
  // The SSE listener accepted a newer frame first.
  expect(acceptEquipmentStatusSnapshot(client, scopeA, frame(scopeA, 5, '2026-10-27T00:00:05Z', { tools: tools('down') }))?.sequence).toBe(5);

  const delayed = await client.fetchQuery(equipmentStatusQueryOptions(scopeA.siteId, scopeA.fabId));
  expect(delayed.sequence).toBe(5);
  expect(delayed.tools[0].state).toBe('down');
  expect(client.getQueryData<EquipmentStatusSnapshot>(keyA)?.sequence).toBe(5);
});

it('rejects missing fields, partial FAB frames and crossed identities before the cache', () => {
  const client = freshClient();
  const onInvalid = vi.fn();
  activateEquipmentStatusScope(client, scopeA, onInvalid);
  const invalid: unknown[] = [
    { siteId: scopeA.siteId, fabId: scopeA.fabId, tools: tools() }, // missing generatedAt
    { ...frame(scopeA, 1, 'not-a-timestamp') },
    frame(scopeA, 1, '2026-10-27T00:00:01Z', { tools: tools().slice(1) }), // partial FAB frame
    frame(scopeA, 1, '2026-10-27T00:00:01Z', { tools: [{ state: 'UP' }] }),
    frame(scopeA, -1, '2026-10-27T00:00:01Z'),
    frame(scopeA, 1, '2026-10-27T00:00:01Z', { epoch: 1.5 }),
    frame(scopeB, 1, '2026-10-27T00:00:01Z'), // crossed FAB
    'not-an-object',
    null,
  ];
  for (const value of invalid) {
    expect(acceptEquipmentStatusSnapshot(client, scopeA, value), JSON.stringify(value)).toBeUndefined();
  }
  expect(client.getQueryData(keyA)).toBeUndefined();
  expect(onInvalid).toHaveBeenCalledTimes(invalid.length);
});

it('accepts one large valid frame and keeps it as the sole cached snapshot', () => {
  const client = freshClient();
  activateEquipmentStatusScope(client, scopeA);
  // A large but contract-valid frame: one state per layout tool plus extra wire
  // fields the protocol tolerates (the schema at the REST boundary strips them).
  const large = {
    ...frame(scopeA, 1, '2026-10-27T00:00:01Z', { tools: tools('idle') }),
    padding: 'x'.repeat(1_000_000),
  };
  const accepted = acceptEquipmentStatusSnapshot(client, scopeA, large);
  expect(accepted?.tools).toHaveLength(FAB_LAYOUT.length);
  expect(client.getQueryData(keyA)).toBe(accepted);

  // An oversized tool list is a complete-but-wrong layout and stays rejected.
  const oversized = frame(scopeA, 2, '2026-10-27T00:00:02Z', { tools: [...tools(), { state: 'running' }] });
  expect(acceptEquipmentStatusSnapshot(client, scopeA, oversized)).toBeUndefined();
  expect(client.getQueryData<EquipmentStatusSnapshot>(keyA)?.sequence).toBe(1);
});

it('keeps ordering state per QueryClient and resettable for teardown', () => {
  const first = freshClient();
  const second = freshClient();
  activateEquipmentStatusScope(first, scopeA);
  expect(acceptEquipmentStatusSnapshot(first, scopeA, frame(scopeA, 10, '2026-10-27T00:00:10Z'))?.sequence).toBe(10);
  // A second QueryClient has no shared ordering history for the same composite identity.
  expect(second.getQueryData(keyA)).toBeUndefined();
  expect(acceptEquipmentStatusSnapshot(second, scopeA, frame(scopeA, 1, '2026-10-27T00:00:01Z'))?.sequence).toBe(1);

  // Page teardown drops ordering state for one client only.
  resetEquipmentStatusGates(first);
  expect(first.getQueryData<EquipmentStatusSnapshot>(keyA)?.sequence).toBe(10);
  expect(acceptEquipmentStatusSnapshot(first, scopeA, frame(scopeA, 2, '2026-10-27T00:00:02Z'))?.sequence).toBe(2);
  expect(second.getQueryData<EquipmentStatusSnapshot>(keyA)?.sequence).toBe(1);
});
