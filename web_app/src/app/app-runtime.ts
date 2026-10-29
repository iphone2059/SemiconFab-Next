import { Effect, Layer, ManagedRuntime } from 'effect';
import type * as Fiber from 'effect/Fiber';
import * as AtomRegistry from 'effect/reactivity/AtomRegistry';
import { scheduleTask } from '@effect/atom-react';

/**
 * Application composition root: one shared AtomRegistry and one managed Effect
 * runtime per application lifetime. Router loaders, React providers and future
 * resource atoms resolve the same instance through RouterContext/React context.
 *
 * The registry default idle TTL is explicit (target 300s); per-resource TTLs are
 * layered on with Atom.setIdleTTL by the resource modules (Task 5). Never rely on
 * RegistryProvider's own default registry.
 */
export const DEFAULT_IDLE_TTL_MS = 300_000;

export interface AppRuntimeOptions<R> {
  /** Shared application services, built lazily and exactly once per runtime. */
  readonly layer: Layer.Layer<R, never>;
  readonly defaultIdleTTL?: number;
  /** Test/composition seam: inject an existing registry instead of creating one. */
  readonly registry?: AtomRegistry.AtomRegistry;
}

export interface AppRuntime<R = never> {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly services: ManagedRuntime.ManagedRuntime<R, never>;
  /** The only approved Effect execution boundary for application code. */
  runPromise<A, E>(effect: Effect.Effect<A, E, R>): Promise<A>;
  runSync<A, E>(effect: Effect.Effect<A, E, R>): A;
  /** Long-lived fibers are owned by the runtime scope and interrupted on dispose. */
  runFork<A, E>(effect: Effect.Effect<A, E, R>): Fiber.Fiber<A, E>;
  /** True once dispose has started; resource adapters must not write afterwards. */
  readonly disposed: boolean;
  /** Stops app tasks/subscriptions first, then releases registry nodes. Idempotent. */
  dispose(): Promise<void>;
}

export function createApplicationRuntime<R = never>(options: AppRuntimeOptions<R>): AppRuntime<R> {
  const registry = options.registry ?? AtomRegistry.make({
    scheduleTask,
    defaultIdleTTL: options.defaultIdleTTL ?? DEFAULT_IDLE_TTL_MS,
  });
  const services = ManagedRuntime.make(options.layer);
  let disposal: Promise<void> | undefined;
  let disposed = false;

  const dispose = (): Promise<void> => {
    if (!disposal) {
      disposed = true;
      disposal = (async () => {
        await services.dispose();
        registry.dispose();
      })();
    }
    return disposal;
  };

  return {
    registry,
    services,
    runPromise: (effect) => services.runPromise(effect),
    runSync: (effect) => services.runSync(effect),
    runFork: (effect) => services.runFork(effect),
    get disposed() { return disposed; },
    dispose,
  };
}

/**
 * One application-lifetime runtime. The product entry point imports this module;
 * React providers and the router receive the same instance. Tests must construct
 * isolated runtimes with createApplicationRuntime instead of sharing this one.
 */
export const applicationRuntime: AppRuntime<never> = createApplicationRuntime({ layer: Layer.empty });
