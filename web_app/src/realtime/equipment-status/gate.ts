import {
  isValidEquipmentStatusSnapshot,
  type EquipmentStatusScope,
  type EquipmentStatusSnapshot,
} from './protocol';

/**
 * The ordered acceptance gate of one FAB scope (framework-free on purpose so the
 * REST queryFn and the SSE listener can share the exact same rules).
 *
 * This is the only authority for Server Epoch + Sequence ordering:
 * - In-scope, full, well-typed snapshots only (protocol.ts validates the shape;
 *   the gate supplies the exact FAB tool count).
 * - `sequence`/timestamp high-water per accepted scope (legacy behaviour is
 *   preserved exactly when no epoch is present).
 * - `epoch` orders server generations: a higher epoch resets the high-water and
 *   is accepted; a lower epoch is a delayed frame from an old generation and is
 *   rejected without being reported as invalid.
 */
export interface EquipmentStatusGate {
  /** Validate + order one candidate frame; returns the accepted snapshot or undefined. */
  readonly accept: (value: unknown) => EquipmentStatusSnapshot | undefined;
}

export function createEquipmentStatusGate(
  scope: EquipmentStatusScope,
  expectedToolCount: number,
  onInvalid?: () => void,
): EquipmentStatusGate {
  let lastGeneratedAt = Number.NEGATIVE_INFINITY;
  let lastSequence = -1;
  let lastEpoch: number | undefined;
  return {
    accept(value: unknown): EquipmentStatusSnapshot | undefined {
      if (!isValidEquipmentStatusSnapshot(value, scope, expectedToolCount)) {
        onInvalid?.();
        return undefined;
      }
      const snapshot = value;
      const timestamp = Date.parse(snapshot.generatedAt);
      const hasSequence = snapshot.sequence !== undefined;
      const hasEpoch = snapshot.epoch !== undefined;
      if (hasEpoch) {
        // Explicit generation ordering never falls back to display time. The
        // first epoch also replaces all legacy high-water marks.
        if (!hasSequence) { onInvalid?.(); return undefined; }
        const epoch = snapshot.epoch as number;
        const sequence = snapshot.sequence as number;
        if (lastEpoch !== undefined && (epoch < lastEpoch || (epoch === lastEpoch && sequence <= lastSequence))) return undefined;
        lastEpoch = epoch;
        lastSequence = sequence;
        lastGeneratedAt = timestamp;
        return snapshot;
      }
      // A legacy/late response must not downgrade a feed that has established
      // an explicit server generation.
      if (lastEpoch !== undefined) return undefined;
      if (hasSequence) {
        const sequence = snapshot.sequence as number;
        if (sequence < lastSequence) {
          // Legacy-only server-restart heuristic (no explicit epoch observed).
          if (timestamp <= lastGeneratedAt) return undefined;
        } else if (sequence === lastSequence) {
          return undefined;
        }
      } else if (timestamp < lastGeneratedAt) {
        return undefined;
      }
      if (hasSequence) lastSequence = snapshot.sequence as number;
      lastGeneratedAt = timestamp;
      return snapshot;
    },
  };
}

/**
 * Accept only a valid, in-scope snapshot that does not predate the most recently
 * applied REST or SSE frame. Kept for callers that want a boolean consumer; the
 * shared REST/SSE cache boundary lives in api/cache/equipment-status-bridge.
 */
export function createOrderedEquipmentStatusConsumer(
  scope: EquipmentStatusScope,
  expectedToolCount: number,
  onSnapshot: (snapshot: EquipmentStatusSnapshot) => void,
  onInvalid?: () => void,
): (value: unknown) => boolean {
  const gate = createEquipmentStatusGate(scope, expectedToolCount, onInvalid);
  return (value: unknown): boolean => {
    const accepted = gate.accept(value);
    if (!accepted) return false;
    onSnapshot(accepted);
    return true;
  };
}
