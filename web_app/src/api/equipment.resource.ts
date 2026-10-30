import { Effect, Option, Schema } from 'effect';
import * as AsyncResult from 'effect/reactivity/AsyncResult';
import { nonEmptyString, nonNegativeInteger } from '@/api/primitives.schema';
import { defineResource, type CommitDecision, type ResourceCommitContext, type ResourceKey } from '@/api/resource';
import { RESOURCE_POLICIES } from '@/api/resource-policy';
import {
  isValidEquipmentStatusSnapshot,
  type EquipmentStatusScope,
  type EquipmentStatusSnapshot,
} from '@/realtime/equipment-status.protocol';
import { compareEquipmentStatusSnapshot, type EquipmentStatusOrdering } from '@/realtime/equipment-status.gate';
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

/**
 * Native REST boundary for one FAB snapshot. The wire payload is validated
 * through the same protocol module the SSE stream uses, including the exact FAB
 * tool count and the composite (siteId, fabId) identity, before it can reach a
 * commit. A rejected payload fails the read; it never reaches the Atom.
 */
export const fetchEquipmentStatus = (siteId: string, fabId: string) => {
  const scope: EquipmentStatusScope = { siteId, fabId };
  return httpTransport.fetchJson(
    `/api/v1/sites/${encodeURIComponent(siteId)}/fabs/${encodeURIComponent(fabId)}/equipment-status`,
  ).pipe(
    Effect.flatMap(decodeApiResponse(equipmentStatusSchema, 'invalid equipment-status response')),
    Effect.flatMap((value) => Effect.try({
      try: (): EquipmentStatusSnapshot => {
        if (!isValidEquipmentStatusSnapshot(value, scope, FAB_LAYOUT.length)) {
          throw new Error('equipment-status snapshot failed the scope/payload contract');
        }
        return value;
      },
      catch: (cause) => new InvalidServerResponse(cause instanceof Error ? cause.message : 'invalid equipment-status', cause),
    })),
  );
};

/** Canonical composite resource key for one FAB's equipment status (ADR-006 §2.1). */
export const equipmentStatusKey = (siteId: string, fabId: string): ResourceKey =>
  'equipment-status\u0000' + siteId + '\u0000' + fabId;

/**
 * Accepted (epoch, sequence) high-water of one FAB, read from the Atom's own
 * current state inside the same synchronous commit step (ADR-006 §2.5). Never a
 * second gate object and never a captured "previous request" value.
 */
function acceptedHighWater(
  current: AsyncResult.AsyncResult<EquipmentStatusSnapshot, unknown>,
): EquipmentStatusOrdering | undefined {
  const value = Option.getOrUndefined(AsyncResult.value(current));
  return value === undefined ? undefined : { epoch: value.epoch, sequence: value.sequence };
}

/**
 * The single ordered-acceptance rule for the equipment status resource: REST,
 * SSE pushes, reconnect snapshots and recovery snapshots all commit through the
 * manager with this hook. Invalid frames and non-advancing generations return
 * Ignore('rejected'); only a strictly newer (epoch, sequence) is Publish.
 */
export function commitEquipmentStatusSnapshot(
  scope: EquipmentStatusScope,
  next: unknown,
  context: ResourceCommitContext<EquipmentStatusSnapshot>,
): CommitDecision<EquipmentStatusSnapshot> {
  const verdict = compareEquipmentStatusSnapshot(scope, FAB_LAYOUT.length, acceptedHighWater(context.current), next);
  if (verdict._tag === 'Accept') return { _tag: 'Publish', value: verdict.snapshot };
  // Only a valid read with identical version AND content confirms recovery. Equal
  // counters with conflicting tool states remain rejected and cannot clear errors.
  const current = Option.getOrUndefined(AsyncResult.value(context.current));
  if (context.origin === 'read' && verdict.reason === 'stale' && current !== undefined &&
      isValidEquipmentStatusSnapshot(next, scope, FAB_LAYOUT.length) &&
      next.epoch === current.epoch && next.sequence === current.sequence &&
      next.generatedAt === current.generatedAt &&
      next.tools.every((tool, index) => tool.state === current.tools[index]?.state)) {
    return { _tag: 'Ignore', reason: 'rejected', unchanged: true };
  }
  return { _tag: 'Ignore', reason: 'rejected' };
}

/**
 * Immutable per-FAB equipment status definition. The manager owns the single
 * Atom; every read/push goes through its Publish | Ignore commit protocol.
 */
export function equipmentStatusDefinition(siteId: string, fabId: string) {
  const scope: EquipmentStatusScope = { siteId, fabId };
  return defineResource({
    identity: { kind: 'equipment-status', version: 1, key: equipmentStatusKey(siteId, fabId) },
    load: fetchEquipmentStatus(siteId, fabId),
    policy: RESOURCE_POLICIES.equipmentStatus,
    accept: (next: EquipmentStatusSnapshot, context: ResourceCommitContext<EquipmentStatusSnapshot>) =>
      commitEquipmentStatusSnapshot(scope, next, context),
  });
}

/** Explicit error channel alias for the equipment status resource. */
export type EquipmentStatusResourceError = ApiError;