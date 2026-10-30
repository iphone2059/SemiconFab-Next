export function requirePositiveSafeInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(name + ' must be a positive safe integer');
  return value;
}

export function requireNonNegativeSafeInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(name + ' must be a non-negative safe integer');
  return value;
}

export function requirePositiveFiniteNumber(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(name + ' must be a positive finite number');
  return value;
}

export function requireNonNegativeFiniteNumber(name: string, value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(name + ' must be a non-negative finite number');
  return value;
}

export function requireNonEmptyNonNegativeFiniteSequence(name: string, values: readonly number[]): readonly number[] {
  if (values.length === 0 || values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new RangeError(name + ' must contain at least one non-negative finite number');
  }
  return values;
}