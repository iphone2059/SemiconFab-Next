import {
  isValidEquipmentStatusSnapshot,
  type EquipmentStatusScope,
  type EquipmentStatusSnapshot,
} from './protocol';

/**
 * Authoritative ordering: the backend always sends both epoch and sequence.
 * Timestamps are display-only; older generations cannot win by a newer clock.
 */
export interface EquipmentStatusGate {
  readonly accept: (value: unknown) => EquipmentStatusSnapshot | undefined;
}

export function createEquipmentStatusGate(
  scope: EquipmentStatusScope,
  expectedToolCount: number,
  onInvalid?: () => void,
): EquipmentStatusGate {
  let lastEpoch = -1;
  let lastSequence = -1;
  return {
    accept(value: unknown): EquipmentStatusSnapshot | undefined {
      if (!isValidEquipmentStatusSnapshot(value, scope, expectedToolCount)) {
        onInvalid?.();
        return undefined;
      }
      if (value.epoch < lastEpoch ||
          (value.epoch === lastEpoch && value.sequence <= lastSequence)) return undefined;
      lastEpoch = value.epoch;
      lastSequence = value.sequence;
      return value;
    },
  };
}

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
