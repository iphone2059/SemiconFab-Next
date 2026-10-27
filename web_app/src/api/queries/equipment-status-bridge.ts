import type { QueryClient } from '@tanstack/react-query';
import { FAB_LAYOUT } from '../../fab-layout';
import {
  createEquipmentStatusGate,
  type EquipmentStatusGate,
  type EquipmentStatusScope,
  type EquipmentStatusSnapshot,
} from '../../equipment-status';
import { queryKeys } from './queryKeys';

/**
 * Shared bridge between TanStack Query and the framework-free ordered equipment
 * status gate.
 *
 * A01/A02: the FAB-scoped Query cache entry is the single server-snapshot owner.
 * REST (queryFn) and SSE (page listener) must pass the exact same per-scope
 * acceptance rules before a snapshot can be published; ordering high-water marks
 * are kept per (siteId, fabId) and per QueryClient so two FABs of one site never
 * share ordering state and no test can leak it into another.
 */

/** Every FAB status feed carries one state per layout tool; partial frames are rejected. */
export const EQUIPMENT_STATUS_TOOL_COUNT = FAB_LAYOUT.length;

interface ScopeGateEntry {
  readonly gate: EquipmentStatusGate;
}

const gatesByClient = new WeakMap<QueryClient, Map<string, ScopeGateEntry>>();

const scopeKey = (scope: EquipmentStatusScope): string => `${scope.siteId}\u0000${scope.fabId}`;

function scopeGates(client: QueryClient): Map<string, ScopeGateEntry> {
  let gates = gatesByClient.get(client);
  if (!gates) {
    gates = new Map<string, ScopeGateEntry>();
    gatesByClient.set(client, gates);
  }
  return gates;
}

function equipmentStatusKey(scope: EquipmentStatusScope) {
  return queryKeys.equipment.status(scope.siteId, scope.fabId);
}

/**
 * The per-scope ordered gate shared by REST and SSE for one QueryClient.
 * Lazily created so a REST poll that resolves before the page activation effect
 * still goes through the acceptance rules instead of writing the cache directly.
 */
export function equipmentStatusGate(client: QueryClient, scope: EquipmentStatusScope): EquipmentStatusGate {
  const gates = scopeGates(client);
  const key = scopeKey(scope);
  const existing = gates.get(key);
  if (existing) return existing.gate;
  const gate = createEquipmentStatusGate(scope, EQUIPMENT_STATUS_TOOL_COUNT);
  gates.set(key, { gate });
  return gate;
}

/**
 * Start a fresh ordering history for a newly activated FAB scope. A cache value
 * accepted earlier for the same scope seeds the new high-water, so re-entering a
 * FAB can never roll its cache entry back to an older accepted frame.
 */
export function activateEquipmentStatusScope(
  client: QueryClient,
  scope: EquipmentStatusScope,
  onInvalid?: () => void,
): EquipmentStatusGate {
  const gate = createEquipmentStatusGate(scope, EQUIPMENT_STATUS_TOOL_COUNT, onInvalid);
  const cached = client.getQueryData<EquipmentStatusSnapshot>(equipmentStatusKey(scope));
  if (cached) gate.accept(cached);
  scopeGates(client).set(scopeKey(scope), { gate });
  return gate;
}

/** Drop all ordering state for one QueryClient (page teardown / tests). */
export function resetEquipmentStatusGates(client: QueryClient): void {
  gatesByClient.delete(client);
}

/**
 * The single acceptance boundary for the FAB-scoped Query cache: validate the
 * frame against the per-scope ordered gate, and write the cache only when the
 * gate accepted it. Every other transport path must go through here.
 */
export function acceptEquipmentStatusSnapshot(
  client: QueryClient,
  scope: EquipmentStatusScope,
  value: unknown,
): EquipmentStatusSnapshot | undefined {
  const accepted = equipmentStatusGate(client, scope).accept(value);
  if (accepted) client.setQueryData(equipmentStatusKey(scope), accepted);
  return accepted;
}
