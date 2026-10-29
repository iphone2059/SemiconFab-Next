/**
 * Deterministic property/model test support (ADR-009 §5). No external
 * dependency: SplitMix64 gives the same stream for the same decimal seed on
 * every machine, every failure reports the seed, and {@link minimize} shrinks to
 * a concrete minimal counterexample.
 */

const MASK_64 = (1n << 64n) - 1n;

/** SplitMix64: tiny, deterministic, well-distributed 64-bit PRNG. */
export class SplitMix64 {
  private state: bigint;

  constructor(readonly seed: number | bigint) {
    this.state = BigInt(seed) & MASK_64;
  }

  nextUint64(): bigint {
    this.state = (this.state + 0x9e3779b97f4a7c15n) & MASK_64;
    let z = this.state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK_64;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK_64;
    return (z ^ (z >> 31n)) & MASK_64;
  }

  nextUint32(): number {
    return Number(this.nextUint64() >> 32n);
  }

  /** Uniform integer in [0, maxExclusive); maxExclusive must be positive. */
  nextInt(maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) throw new Error('maxExclusive must be a positive integer');
    return this.nextUint32() % maxExclusive;
  }

  /** True with the given probability in [0, 1]. */
  nextBoolean(probability = 0.5): boolean {
    return (this.nextUint32() & 0xffff) / 0x10000 < probability;
  }

  pick<T>(values: readonly T[]): T {
    if (values.length === 0) throw new Error('cannot pick from an empty list');
    return values[this.nextInt(values.length)];
  }

  shuffle<T>(values: readonly T[]): T[] {
    const copy = [...values];
    for (let index = copy.length - 1; index > 0; index -= 1) {
      const swap = this.nextInt(index + 1);
      [copy[index], copy[swap]] = [copy[swap], copy[index]];
    }
    return copy;
  }
}

/** Deterministic seed label used in failure messages and evidence logs. */
export function formatSeed(seed: number): string {
  return 'seed=0x' + seed.toString(16) + ' (' + seed + ')';
}

export interface SeedRunOptions {
  /** Number of deterministic seeds to try; default 24. */
  readonly seeds?: number;
  /** First seed; default 1. */
  readonly baseSeed?: number;
  readonly label: string;
}

/**
 * Run a property check once per deterministic seed. On failure the thrown error
 * names the label and the exact decimal seed so the case is reproducible; the
 * original error stays attached as `cause`.
 */
export function forEachSeed(options: SeedRunOptions, check: (random: SplitMix64, seed: number) => void): void {
  const seeds = Math.max(1, options.seeds ?? 24);
  const baseSeed = options.baseSeed ?? 1;
  for (let index = 0; index < seeds; index += 1) {
    const seed = baseSeed + index;
    try {
      check(new SplitMix64(seed), seed);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new Error(options.label + ' failed at ' + formatSeed(seed) + ': ' + detail, { cause });
    }
  }
}

/** Async variant of {@link forEachSeed} for checks that need effectful cleanup. */
export async function forEachSeedAsync(
  options: SeedRunOptions,
  check: (random: SplitMix64, seed: number) => Promise<void>,
): Promise<void> {
  const seeds = Math.max(1, options.seeds ?? 24);
  const baseSeed = options.baseSeed ?? 1;
  for (let index = 0; index < seeds; index += 1) {
    const seed = baseSeed + index;
    try {
      await check(new SplitMix64(seed), seed);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new Error(options.label + ' failed at ' + formatSeed(seed) + ': ' + detail, { cause });
    }
  }
}

/**
 * Generic greedy minimizer: repeatedly applies the best failing shrink until no
 * smaller candidate fails. Returns the minimal counterexample in the supplied
 * shrink order.
 */
export function minimize<T>(initial: T, shrink: (value: T) => readonly T[], fails: (value: T) => boolean): T {
  let current = initial;
  let improved = true;
  while (improved) {
    improved = false;
    for (const candidate of shrink(current)) {
      if (fails(candidate)) {
        current = candidate;
        improved = true;
        break;
      }
    }
  }
  return current;
}

/**
 * Async variant of {@link minimize} for counterexamples that need effectful
 * replay/cleanup between candidates (Fresh runtime per candidate).
 */
export async function minimizeAsync<T>(
  initial: T,
  shrink: (value: T) => readonly T[],
  fails: (value: T) => Promise<boolean>,
): Promise<T> {
  let current = initial;
  let improved = true;
  while (improved) {
    improved = false;
    for (const candidate of shrink(current)) {
      if (await fails(candidate)) {
        current = candidate;
        improved = true;
        break;
      }
    }
  }
  return current;
}

/** Deterministic list shrink candidates: halve the list, then delete single items. */
export function arrayShrinks<T>(values: readonly T[]): readonly (readonly T[])[] {
  if (values.length <= 1) return [];
  const candidates: T[][] = [];
  for (let size = Math.max(1, Math.floor(values.length / 2)); size >= 1; size = Math.floor(size / 2)) {
    for (let start = 0; start + size <= values.length; start += size) {
      candidates.push([...values.slice(0, start), ...values.slice(start + size)]);
    }
    if (size === 1) break;
  }
  return candidates;
}

/** JSON shape for failure reports; bigint-safe. */
export function describeExample(value: unknown): string {
  return JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item));
}
