import {
  isValidEquipmentStatusSnapshot,
  type EquipmentStatusScope,
  type EquipmentStatusSnapshot,
} from '@/realtime/equipment-status.protocol';

/**
 * Authoritative ordering metadata: epoch is the server generation, sequence is
 * monotonic within it. Display timestamps never participate in ordering.
 */
export interface EquipmentStatusOrdering {
  readonly epoch: number;
  readonly sequence: number;
}

/** Pure ordering verdict: an accepted snapshot or the rejection reason. */
export type EquipmentStatusComparison =
  | { readonly _tag: 'Accept'; readonly snapshot: EquipmentStatusSnapshot }
  | { readonly _tag: 'Reject'; readonly reason: 'invalid' | 'stale' };

/**
 * Stateless ordered-acceptance comparison (ADR-006 §2.9).
 *
 * The previous mutable gate owned a second copy of the epoch/sequence high-water,
 * which could disagree with the Atom across Activate/reset handovers (G06). This
 * function holds no state: the caller passes the currently accepted high-water
 * read from the same Atom inside one synchronous commit step, and decides
 * Publish | Ignore from the verdict. It validates through protocol.ts so REST,
 * SSE and recovery frames cannot disagree about the scope or payload shape.
 */
export function compareEquipmentStatusSnapshot(
  scope: EquipmentStatusScope,
  expectedToolCount: number,
  previous: EquipmentStatusOrdering | undefined,
  candidate: unknown,
): EquipmentStatusComparison {
  if (!isValidEquipmentStatusSnapshot(candidate, scope, expectedToolCount)) {
    return { _tag: 'Reject', reason: 'invalid' };
  }
  if (previous !== undefined &&
      (candidate.epoch < previous.epoch ||
       (candidate.epoch === previous.epoch && candidate.sequence <= previous.sequence))) {
    return { _tag: 'Reject', reason: 'stale' };
  }
  return { _tag: 'Accept', snapshot: candidate };
}
