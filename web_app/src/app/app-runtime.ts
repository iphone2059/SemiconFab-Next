import { Effect, Exit, Layer, ManagedRuntime, Scope } from 'effect';
import type * as Fiber from 'effect/Fiber';
import * as AtomRegistry from 'effect/reactivity/AtomRegistry';
import { scheduleTask } from '@effect/atom-react';
import type { ResourceManager } from '@/api/resource';
import { createResourceManager } from '@/api/resource-manager';

/**
 * Application composition root: one shared AtomRegistry, one managed Effect
 * runtime and one resource manager per application lifetime (ADR-006/ADR-007).
 *
 * Ownership model (ADR-007 §2):
 * - `rootScope` is the AppScope: a child of `ManagedRuntime.scope`; every
 *   ResourceScope and FabScope forks from it;
 * - `resources` is the single ResourceManager of this runtime: the only owner of
 *   resource coordination entries, resource scopes, polling fibers and commits;
 * - `forkScope()` is the explicit child-scope factory for FabRuntime/Rendering
 *   owners, so no business module creates a detached Scope of its own.
 *
 * React providers and router loaders resolve the same instance through React
 * context. Tests must construct isolated runtimes with createApplicationRuntime
 * instead of sharing the application singleton.
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
  /** AppScope: parent of every ResourceScope / FabScope; closed by dispose(). */
  readonly rootScope: Scope.Closeable;
  /** The single resource manager of this runtime (ADR-006 §2.8). */
  readonly resources: ResourceManager<AppRuntime<never>>;
  /** The only approved Effect execution boundary for application code. */
  runPromise<A, E>(effect: Effect.Effect<A, E, R>): Promise<A>;
  runSync<A, E>(effect: Effect.Effect<A, E, R>): A;
  /** Long-lived fibers are owned by the runtime scope and interrupted on dispose. */
  runFork<A, E>(effect: Effect.Effect<A, E, R>): Fiber.Fiber<A, E>;
  /** Fork an explicitly owned child scope (FabScope / RenderingScope) from AppScope. */
  forkScope(): Scope.Closeable;
  /** True once dispose has started; resource adapters must not write afterwards. */
  readonly disposed: boolean;
  /**
   * Fixed teardown order (ADR-007 §2): resources.dispose() -> close rootScope ->
   * services.dispose() -> registry.dispose(). Idempotent.
   */
  dispose(): Promise<void>;
}

export function createApplicationRuntime<R = never>(options: AppRuntimeOptions<R>): AppRuntime<R> {
  const registry = options.registry ?? AtomRegistry.make({
    scheduleTask,
    defaultIdleTTL: options.defaultIdleTTL ?? DEFAULT_IDLE_TTL_MS,
  });
  const services = ManagedRuntime.make(options.layer);
  const rootScope = Scope.forkUnsafe(services.scope);
  let disposal: Promise<void> | undefined;
  let disposed = false;
  let resources: ResourceManager<AppRuntime<never>> | undefined;

  const dispose = (): Promise<void> => {
    if (!disposal) {
      disposed = true;
      disposal = (async () => {
        // 1. Resource manager first: in-flight commits are ignored from this point,
        //    every ResourceScope/poll fiber owner is released.
        resources?.dispose();
        // 2. Close AppScope: cascades any still-attached child scopes (exactly once).
        await services.runPromise(Scope.close(rootScope, Exit.void)).catch(() => undefined);
        // 3/4. Services, then the registry (no resource adapter may write after 1).
        await services.dispose();
        registry.dispose();
      })();
    }
    return disposal;
  };

  const runtime: AppRuntime<R> = {
    registry,
    services,
    rootScope,
    get resources(): ResourceManager<AppRuntime<never>> {
      if (!resources) throw new Error('AppRuntime resources are not initialised');
      return resources;
    },
    runPromise: (effect) => services.runPromise(effect),
    runSync: (effect) => services.runSync(effect),
    runFork: (effect) => services.runFork(effect),
    forkScope: () => {
      if (disposed) throw new Error('AppRuntime is disposed');
      return Scope.forkUnsafe(rootScope);
    },
    get disposed() { return disposed; },
    dispose,
  };

  // The manager is constructed after the runtime facade so host.runtime is the
  // exact application runtime instance (identity, not a structural copy). The
  // manager never touches it during construction.
  resources = createResourceManager<AppRuntime<never>>({
    // R14 justification: the composition root is the only place that erases the resource
    // services channel; every product/test instantiation uses Layer.empty (R = never), and the
    // manager never re-enters services typing (it only runs resource-load effects that require
    // no services). The facade identity (runtime/resources) is preserved for manager.runtime.
    runtime: runtime as unknown as AppRuntime<never>,
    registry,
    // R14 justification: same composition-root erasure as runtime above; services is created
    // from Layer.empty (never) in every current instantiation of createApplicationRuntime.
    services: services as unknown as ManagedRuntime.ManagedRuntime<never, never>,
    rootScope,
    isDisposed: () => disposed,
  });

  return runtime;
}

/**
 * One application-lifetime runtime. The product entry point imports this module;
 * React providers and the router receive the same instance.
 */
export const applicationRuntime: AppRuntime<never> = createApplicationRuntime({ layer: Layer.empty });
