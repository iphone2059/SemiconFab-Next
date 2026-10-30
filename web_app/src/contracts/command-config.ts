/**
 * Strict configuration validation for the command runtime (R4-07).
 *
 * Public capacity/timeout options used to be normalised with Math.max, which
 * silently accepted NaN (every bound comparison becomes false, so the bound is
 * gone) and Infinity (never reached). A broken resource bound is a correctness
 * bug, not a cosmetic fallback: every explicit option must be validated at
 * construction time and fail fast instead of degrading the bound.
 *
 * These helpers are pure and have no dependency on the Effect runtime so they
 * can be used by the transport, scheduler, recovery queue and correlation
 * registry without creating an import cycle.
 */

/** Raised when an explicit runtime/transport option is not a usable bound. */
export class CommandConfigurationError extends Error {
  constructor(
    readonly option: string,
    readonly reason: string,
    readonly received: unknown,
  ) {
    super('invalid command runtime option "' + option + '": ' + reason + ' (received ' + String(received) + ')');
    this.name = 'CommandConfigurationError';
  }
}

interface IntegerBounds {
  /** Inclusive lower bound. */
  readonly min: number;
  /** Inclusive upper bound; omit for no explicit maximum. */
  readonly max?: number;
}

/**
 * Resolve a required safe-integer option. `undefined` selects the documented
 * default; anything else must be a finite safe integer inside the bounds.
 */
export function resolveIntegerOption(
  option: string,
  value: number | undefined,
  fallback: number,
  bounds: IntegerBounds,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved)) {
    throw new CommandConfigurationError(option, 'must be a finite safe integer', value);
  }
  if (resolved < bounds.min || (bounds.max !== undefined && resolved > bounds.max)) {
    const range = bounds.max === undefined ? '>= ' + bounds.min : bounds.min + '..' + bounds.max;
    throw new CommandConfigurationError(option, 'must be inside ' + range, value);
  }
  return resolved;
}

/**
 * Resolve a timeout/delay in milliseconds. Timeouts must be finite and >= 1ms;
 * zero-delay timers use a separate non-negative variant so a test seam cannot
 * smuggle NaN into setTimeout (which treats NaN as 1ms but loses the bound).
 */
export function resolveTimeoutOption(
  option: string,
  value: number | undefined,
  fallback: number,
  bounds: { readonly min: number; readonly max?: number },
): number {
  const resolved = value ?? fallback;
  if (typeof resolved !== 'number' || !Number.isFinite(resolved)) {
    throw new CommandConfigurationError(option, 'must be a finite number of milliseconds', value);
  }
  if (resolved < bounds.min || (bounds.max !== undefined && resolved > bounds.max)) {
    const range = bounds.max === undefined ? '>= ' + bounds.min : bounds.min + '..' + bounds.max;
    throw new CommandConfigurationError(option, 'must be inside ' + range, value);
  }
  return resolved;
}

/**
 * Resolve the bounded retry backoff schedule. An explicit schedule must be a
 * non-empty array of finite non-negative delays; an invalid schedule must never
 * silently fall back to the default because that hides a configuration fault.
 */
export function resolveBackoffSchedule(
  option: string,
  value: readonly number[] | undefined,
  fallback: readonly number[],
): readonly number[] {
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || value.length === 0) {
    throw new CommandConfigurationError(option, 'must be a non-empty array of millisecond delays', value);
  }
  for (const delay of value) {
    if (typeof delay !== 'number' || !Number.isFinite(delay) || delay < 0) {
      throw new CommandConfigurationError(option, 'every backoff delay must be finite and >= 0', delay);
    }
  }
  return [...value];
}

/** Validate a clock/test seam supplied by the caller; never accept a non-function. */
export function resolveClockOption(option: string, value: (() => number) | undefined, fallback: () => number): () => number {
  if (value === undefined) return fallback;
  if (typeof value !== 'function') throw new CommandConfigurationError(option, 'must be a function', value);
  return value;
}