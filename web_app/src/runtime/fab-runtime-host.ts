import type { Effect } from 'effect';

/**
 * The narrow Effect execution boundary a FabRuntime/scheduler needs. The
 * application composition root (`AppRuntime<never>`) satisfies it structurally,
 * so runtime/ modules never import app/ (which imports runtime/, ADR-007 §2:
 * no dependency cycle and no global Effect runner outside app-runtime).
 */
export interface RuntimeHost {
  runSync<A>(effect: Effect.Effect<A, never, never>): A;
  runPromise<A, E>(effect: Effect.Effect<A, E, never>): Promise<A>;
}
