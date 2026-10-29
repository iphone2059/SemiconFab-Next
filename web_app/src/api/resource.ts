import { Duration, Effect, Option } from 'effect';
import * as AsyncResult from 'effect/reactivity/AsyncResult';
import * as Atom from 'effect/reactivity/Atom';
import type * as AtomRegistry from 'effect/reactivity/AtomRegistry';
import type { AppRuntime } from '@/app/app-runtime';
import type { ResourcePolicy } from '@/api/resource-policy';

/**
 * A remote resource Atom: one writable AsyncResult cell per logical resource
 * identity, plus the Effect used to load it. The Atom is the only value owner;
 * freshness/idle TTL are control metadata (not a second cache).
 */
export interface Resource<A, E> {
  readonly atom: Atom.Writable<AsyncResult.AsyncResult<A, E>, AsyncResult.AsyncResult<A, E>>;
  readonly load: Effect.Effect<A, E, never>;
  readonly policy: ResourcePolicy;
}

/** Deterministic family keyed by logical identity; repeated calls return the same Resource. */
export function resourceFamily<Key extends string, A, E>(
  create: (key: Key) => Resource<A, E>,
): (key: Key) => Resource<A, E> {
  const cache = new Map<Key, Resource<A, E>>();
  return (key: Key): Resource<A, E> => {
    const existing = cache.get(key);
    if (existing) return existing;
    const created = create(key);
    cache.set(key, created);
    return created;
  };
}

export function makeResource<A, E>(load: Effect.Effect<A, E, never>, policy: ResourcePolicy): Resource<A, E> {
  const atom = Atom.writable<AsyncResult.AsyncResult<A, E>, AsyncResult.AsyncResult<A, E>>(
    () => AsyncResult.initial<A, E>(),
    (context, value) => context.setSelf(value),
  ).pipe(Atom.setIdleTTL(Duration.millis(policy.idleTtlMs)));
  return { atom, load, policy };
}

/** One in-flight load per Resource instance; every waiter shares the same request. */
const inFlight = new WeakMap<Resource<unknown, unknown>, Promise<unknown>>();

function currentSuccess<A, E>(
  registry: AtomRegistry.AtomRegistry,
  resource: Resource<A, E>,
): Option.Option<AsyncResult.Success<A, E>> {
  const current = registry.get(resource.atom);
  if (AsyncResult.isSuccess(current)) return Option.some(current);
  if (AsyncResult.isFailure(current)) return current.previousSuccess;
  return Option.none();
}

/**
 * Starts or joins the resource read. A failure keeps the previous successful
 * value inside the Atom (AsyncResult.previousSuccess) and returns a typed error;
 * callers must never treat the retained value as freshly validated.
 */
export function refreshResource<A, E>(runtime: AppRuntime<never>, resource: Resource<A, E>): Promise<A> {
  if (runtime.disposed) return Promise.reject(new Error('AppRuntime is disposed'));
  const existing = inFlight.get(resource as Resource<unknown, unknown>);
  if (existing) return existing as Promise<A>;

  const registry = runtime.registry;
  const previous = currentSuccess(registry, resource);
  const previousValue = Option.getOrUndefined(previous);
  if (previousValue) registry.set(resource.atom, AsyncResult.success(previousValue.value, { waiting: true }));

  const request = runtime.runPromise(resource.load)
    .then((value) => {
      if (!runtime.disposed) registry.set(resource.atom, AsyncResult.success(value));
      return value;
    })
    .catch((error: E) => {
      if (!runtime.disposed) registry.set(resource.atom, AsyncResult.failWithPrevious(error, { previous }));
      throw error;
    })
    .finally(() => { inFlight.delete(resource as Resource<unknown, unknown>); });

  inFlight.set(resource as Resource<unknown, unknown>, request);
  return request;
}

/**
 * Freshness-on-mount/navigation helper: a fresh success is reused without a
 * request; stale/missing values refresh and share the in-flight read. This is the
 * explicit replacement for Query staleTime because Atom reclaims an idle node
 * after its TTL instead of revalidating on every mount.
 */
export async function ensureResource<A, E>(runtime: AppRuntime<never>, resource: Resource<A, E>): Promise<A> {
  if (runtime.disposed) throw new Error('AppRuntime is disposed');
  const current = runtime.registry.get(resource.atom);
  if (AsyncResult.isSuccess(current)) {
    const age = Date.now() - current.timestamp;
    if (age < resource.policy.freshnessMs) return current.value;
  }
  return refreshResource(runtime, resource);
}

/** Writes a transport-accepted snapshot (SSE or mutation result) into the Atom. */
export function setResourceValue<A, E>(
  runtime: AppRuntime<never>,
  resource: Resource<A, E>,
  value: A,
): void {
  if (runtime.disposed) return;
  runtime.registry.set(resource.atom, AsyncResult.success(value));
}

/** Reads the retained value (including the last success behind a failure). */
export function resourceValue<A, E>(
  registry: AtomRegistry.AtomRegistry,
  resource: Resource<A, E>,
): A | undefined {
  return Option.getOrUndefined(AsyncResult.value(registry.get(resource.atom)));
}

/** Explicit invalidation used by mutations; never a global cache clear. */
export function invalidateResource<A, E>(runtime: AppRuntime<never>, resource: Resource<A, E>): void {
  void refreshResource(runtime, resource).catch(() => {
    /* error is stored in the Atom; callers surface it from there */
  });
}

/** No cache-clear helper: resource identity is precise, invalidation is per-resource. */
