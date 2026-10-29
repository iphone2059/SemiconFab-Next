import { Effect, Schema } from 'effect';
import type * as AtomRegistry from 'effect/reactivity/AtomRegistry';
import { nonEmptyString, nonNegativeInteger } from '@/api/primitives.schema';
import { makeResource, resourceFamily, setResourceValue } from '@/api/resource';
import { RESOURCE_POLICIES } from '@/api/resource-policy';
import type { EquipmentStatusSnapshot, EquipmentStatusScope } from '@/realtime/equipment-status.protocol';
import { createEquipmentStatusGate, type EquipmentStatusGate } from '@/realtime/equipment-status.gate';
import { FAB_LAYOUT } from '@/domain/fab-layout';
import { httpTransport, decodeApiResponse, InvalidServerResponse, type ApiError } from '@/api/http.transport';

const equipmentStatusSchema = Schema.Struct({
  siteId: nonEmptyString,
  fabId: nonEmptyString,
  generatedAt: nonEmptyString,
  sequence: nonNegativeInteger,
  epoch: nonNegativeInteger,
  tools: Schema.Array(Schema.Struct({ state: nonEmptyString })).pipe(Schema.mutable).check(Schema.isMinLength(1)),
});

export const fetchEquipmentStatus = (siteId: string, fabId: string) => httpTransport.fetchJson(
  `/api/v1/sites/${encodeURIComponent(siteId)}/fabs/${encodeURIComponent(fabId)}/equipment-status`,
).pipe(Effect.flatMap(decodeApiResponse(equipmentStatusSchema, 'invalid equipment-status response')));

/**
 * Per-registry accepted ordering gates. The gate is control metadata (epoch /
 * sequence high-water), never a snapshot copy; REST and SSE for one FAB share the
 * exact same instance, and two FABs never share ordering state.
 */
const gatesByRegistry = new WeakMap<AtomRegistry.AtomRegistry, Map<string, { readonly gate: EquipmentStatusGate }>>();
const scopeKey = (scope: EquipmentStatusScope): string => scope.siteId + '\u0000' + scope.fabId;

function gates(registry: AtomRegistry.AtomRegistry): Map<string, { readonly gate: EquipmentStatusGate }> {
  let value = gatesByRegistry.get(registry);
  if (!value) { value = new Map(); gatesByRegistry.set(registry, value); }
  return value;
}

export function equipmentStatusGate(registry: AtomRegistry.AtomRegistry, scope: EquipmentStatusScope): EquipmentStatusGate {
  const key = scopeKey(scope);
  const existing = gates(registry).get(key);
  if (existing) return existing.gate;
  const gate = createEquipmentStatusGate(scope, FAB_LAYOUT.length);
  gates(registry).set(key, { gate });
  return gate;
}

/** Fresh ordering history for a newly activated scope, seeded by the accepted Atom value. */
export function activateEquipmentStatusScope(
  registry: AtomRegistry.AtomRegistry,
  scope: EquipmentStatusScope,
  onInvalid?: () => void,
): EquipmentStatusGate {
  const gate = createEquipmentStatusGate(scope, FAB_LAYOUT.length, onInvalid);
  const cached = registry.get(equipmentStatusResource(scope.siteId, scope.fabId).atom);
  if (cached._tag === 'Success') gate.accept(cached.value);
  gates(registry).set(scopeKey(scope), { gate });
  return gate;
}

export function resetEquipmentStatusGates(registry: AtomRegistry.AtomRegistry): void {
  gatesByRegistry.delete(registry);
}

/** Single acceptance boundary shared by REST and SSE; only accepted frames reach the Atom. */
export function acceptEquipmentStatusSnapshot(
  runtime: import('@/app/app-runtime').AppRuntime<never>,
  scope: EquipmentStatusScope,
  value: unknown,
): EquipmentStatusSnapshot | undefined {
  const accepted = equipmentStatusGate(runtime.registry, scope).accept(value);
  if (accepted) setResourceValue(runtime, equipmentStatusResource(scope.siteId, scope.fabId), accepted);
  return accepted;
}

const equipmentStatusFamily = resourceFamily((key: string) => {
  const [siteId, fabId] = key.split('\u0000');
  const scope = { siteId, fabId };
  return makeResource(fetchEquipmentStatus(siteId, fabId), RESOURCE_POLICIES.equipmentStatus, {
    // REST polls go through the same ordered gate as SSE; a delayed poll cannot
    // regress a newer accepted snapshot and never overwrites the retained value.
    accept: (next, previous, registry) => {
      const accepted = equipmentStatusGate(registry, scope).accept(next);
      if (accepted) return accepted;
      if (previous !== undefined) return previous;
      throw new InvalidServerResponse('equipment-status snapshot rejected by the ordered acceptance gate');
    },
  });
});

/** FAB-scoped equipment status resource (REST polling fallback + SSE writes). */
export const equipmentStatusResource = (siteId: string, fabId: string) =>
  equipmentStatusFamily(siteId + '\u0000' + fabId);

/** Type alias to keep call sites explicit about the shared ApiError channel. */
export type EquipmentStatusResourceError = ApiError;
