import type { Effect } from 'effect';
import type * as AsyncResult from 'effect/reactivity/AsyncResult';
import type * as Atom from 'effect/reactivity/Atom';
import type * as AtomRegistry from 'effect/reactivity/AtomRegistry';
import type * as Fiber from 'effect/Fiber';
import type * as ManagedRuntime from 'effect/ManagedRuntime';
import type * as Scope from 'effect/Scope';

/**
 * Phase B resource identity and commit protocol (ADR-006 §2.8, frozen API).
 *
 * A {@link ResourceDefinition} is an immutable description of one logical remote
 * resource: its canonical key, the Effect that loads it, its freshness/idle/poll
 * policy and (optionally) the ordered-acceptance hook. Definitions carry no
 * mutable request state, so two AppRuntimes never share request coordination.
 *
 * The single snapshot owner is the {@link ResourceHandle.atom} created by the
 * owning {@link ResourceManager}; every read completion, SSE push, mutation
 * result and recovery snapshot must pass through the manager's synchronous
 * Publish | Ignore commit function (ADR-006 §2.4).
 */
export type ResourceKey = string;

/** Freshness/idle/poll policy. Freshness and idle TTL are deliberately distinct. */
export interface ResourcePolicy {
  /** Age at which a retained success is refreshed on mount/navigation. */
  readonly freshnessMs: number;
  /** Zero-subscriber retention before the manager releases the resource entry. */
  readonly idleTtlMs: number;
  /** Poll interval while at least one consumer is retained (never per component). */
  readonly pollMs?: number;
  /** Whole read deadline (fetch + body + decode), default 30s; finite positive milliseconds. */
  readonly loadTimeoutMs?: number;
}

/** Why a candidate was not published. Every Ignore appends a bounded diagnostic. */
export type IgnoreReason =
  | 'disposed'
  | 'scope-closed'
  | 'stale-request'
  | 'superseded-write'
  | 'rejected'
  | 'capacity';

/** Publish owns payload writes; Ignore may only complete current read control state. */
export type CommitDecision<A> =
  | { readonly _tag: 'Publish'; readonly value: A }
  | {
      readonly _tag: 'Ignore';
      readonly reason: IgnoreReason;
      /** Valid read matches the retained version AND content; may clear an old error, not publish. */
      readonly unchanged?: true;
    };

/** Synchronous commit context handed to {@link ResourceDefinition.accept}. */
export interface ResourceCommitContext<A> {
  /** The value currently owned by this Atom, read in the same synchronous commit step. */
  readonly current: AsyncResult.AsyncResult<A, unknown>;
  readonly origin: 'read' | 'push' | 'mutation' | 'recovery';
  readonly requestId: number | undefined;
  /** writeSeq observed when the candidate request started (read origins only). */
  readonly baselineWriteSeq: number;
  /** writeSeq at commit time. */
  readonly writeSeq: number;
  /** ResourceScope generation of the owning manager entry. */
  readonly scopeGeneration: number;
}

/**
 * Typed resource identity (ADR-013 §1.2). The manager stores the identity of the
 * admitted definition and rejects a same-key definition with a different
 * kind/version/policy instead of silently reusing an unrelated Atom.
 */
export interface ResourceIdentity {
  /** Resource family, e.g. 'sites' | 'run-detail' | 'equipment-status'. */
  readonly kind: string;
  /** Schema/semantics revision of this kind (bump on incompatible change). */
  readonly version: number;
  /** Canonical per-instance key (ADR-006 §2.1). */
  readonly key: ResourceKey;
}

/** Immutable resource definition. Static resources export one; dynamic ones are manager-cached. */
export interface ResourceDefinition<A, E> {
  /** Typed identity: kind + version + canonical key (ADR-013 §1.2). */
  readonly identity: ResourceIdentity;
  readonly load: Effect.Effect<A, E, never>;
  readonly policy: ResourcePolicy;
  /**
   * Ordered-acceptance hook: reads the current Atom state from `context.current`
   * (never a captured previous value), validates the candidate and returns
   * Publish | Ignore. Must be synchronous and side-effect free.
   */
  readonly accept?: (next: A, context: ResourceCommitContext<A>) => CommitDecision<A>;
}

export const DEFAULT_RESOURCE_LOAD_TIMEOUT_MS = 30_000;

/** Infrastructure failure of a bounded read, distinct from business/API failures. */
export class ResourceReadTimeoutError extends Error {
  readonly _tag = 'ResourceReadTimeoutError';
  constructor(readonly key: ResourceKey, readonly timeoutMs: number) {
    super('Resource read exceeded ' + timeoutMs + 'ms: ' + key);
    this.name = 'ResourceReadTimeoutError';
  }
}

/** Stable handle for one (manager, key) resource; the Atom is the only value owner. */
export interface ResourceHandle<A, E> {
  readonly key: ResourceKey;
  readonly atom: Atom.Atom<AsyncResult.AsyncResult<A, E | ResourceReadTimeoutError>>;
  readonly definition: ResourceDefinition<A, E>;
}

/** Bounded diagnostic record for Ignore decisions (newest last, max 32 entries). */
export interface ResourceDiagnostic {
  readonly key: ResourceKey;
  readonly origin: 'read' | 'push' | 'mutation' | 'recovery';
  readonly reason: IgnoreReason;
  readonly requestId?: number;
}

/** Manager statistics used by boundedness gates (CORE-006). */
export interface ResourceManagerStats {
  readonly entries: number;
  readonly inFlight: number;
  readonly polling: number;
  readonly scopes: number;
}

/**
 * Structural runtime surface owned by the manager (an AppRuntime satisfies it).
 * It deliberately avoids importing app/app-runtime to keep the module graph
 * acyclic while preserving the frozen `manager.runtime` identity.
 */
export interface ResourceRuntime {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly services: ManagedRuntime.ManagedRuntime<never, never>;
  readonly rootScope: Scope.Closeable;
  readonly disposed: boolean;
}

/** Explicit resource-system manager, one per AppRuntime (ADR-006 §2.2/§2.6). */
export interface ResourceManager<Runtime extends ResourceRuntime = ResourceRuntime> {
  /** The owning application runtime (identity, not a copy). */
  readonly runtime: Runtime;
  /** Stable handle for a definition key; creates the manager entry when absent. */
  handle<A, E>(definition: ResourceDefinition<A, E>): ResourceHandle<A, E>;
  /** Current Atom state (Initial / Loading / Ready / Refreshing / Failed*). */
  state<A, E>(handle: ResourceHandle<A, E>): AsyncResult.AsyncResult<A, E | ResourceReadTimeoutError>;
  /** Retained value (including the last success behind a typed failure). */
  value<A, E>(handle: ResourceHandle<A, E>): A | undefined;
  /** Freshness-on-mount read: reuse a fresh success, otherwise refresh (single-flight). */
  ensure<A, E>(handle: ResourceHandle<A, E>): Promise<A>;
  /** Force a read (single-flight); the previous success is kept while refreshing. */
  refresh<A, E>(handle: ResourceHandle<A, E>): Promise<A>;
  /** Publish a transport/mutation/recovery snapshot through the commit protocol. */
  publish<A, E>(
    handle: ResourceHandle<A, E>,
    value: A,
    origin?: 'push' | 'mutation' | 'recovery',
  ): CommitDecision<A>;
  /** First subscriber creates the ResourceScope/poll owner; returns the release function. */
  retain<A, E>(handle: ResourceHandle<A, E>): () => void;
  /** Force-release the manager entry for a key (interrupts scope/fibers, deletes metadata). */
  release(key: ResourceKey): void;
  /** Bounded Ignore diagnostics (newest last). */
  readonly diagnostics: readonly ResourceDiagnostic[];
  readonly stats: ResourceManagerStats;
  /** Marks the manager disposed and releases every entry. Idempotent; called by AppRuntime.dispose. */
  dispose(): void;
}

/** Raised by handle() when the bounded dynamic-resource identity cache is exhausted. */
export class ResourceCapacityError extends Error {
  constructor(readonly key: ResourceKey, readonly capacity: number) {
    super('Resource capacity exhausted (' + capacity + ') for key: ' + key);
    this.name = 'ResourceCapacityError';
  }
}

/** Fields whose disagreement makes a same-key definition incompatible (ADR-013 §1.2). */
export type ResourceDefinitionConflictField = 'kind' | 'version' | 'key' | 'policy';

/**
 * Raised by handle() when an existing manager entry for the same canonical key was
 * admitted with a different typed identity or an incompatible policy. Silent
 * generic-erasure reuse of the old handle is forbidden (CR-07).
 */
export class ResourceDefinitionConflictError extends Error {
  constructor(
    readonly key: ResourceKey,
    readonly existing: ResourceIdentity,
    readonly incoming: ResourceIdentity,
    readonly field: ResourceDefinitionConflictField,
  ) {
    super(
      'Resource definition conflict for key "' + key + '" (' + field + '): existing ' +
      existing.kind + '@v' + existing.version + ' vs incoming ' + incoming.kind + '@v' + incoming.version,
    );
    this.name = 'ResourceDefinitionConflictError';
  }
}

/** Host dependencies of createResourceManager; provided by the AppRuntime composition root. */
export interface ResourceManagerHost<Runtime extends ResourceRuntime = ResourceRuntime> {
  /** The owning AppRuntime instance (exposed as manager.runtime without a module cycle). */
  readonly runtime: Runtime;
  readonly registry: AtomRegistry.AtomRegistry;
  readonly services: ManagedRuntime.ManagedRuntime<never, never>;
  readonly rootScope: Scope.Closeable;
  readonly isDisposed: () => boolean;
}

/** In-flight control metadata (never a payload cache). */
export interface ResourceInFlight {
  readonly requestId: number;
  readonly promise: Promise<unknown>;
  readonly interrupt: () => void;
}

/** Identity helper that keeps definition files annotation-free while preserving A/E inference. */
export function defineResource<A, E>(definition: ResourceDefinition<A, E>): ResourceDefinition<A, E> {
  return definition;
}

/** Exposed for tests/architecture checks: the immutable Atom cell factory used by the manager. */
export const resourceAtomIdleTTL = (policy: ResourcePolicy): number => policy.idleTtlMs;

/** Type-only helper retained for callers that only need the load signature. */
export type ResourceLoad<A, E> = Effect.Effect<A, E, never>;

/** Type-only helper: handles are manager-owned; a Fiber type import keeps the contract explicit. */
export type ResourceFiber<A, E> = Fiber.Fiber<A, E>;
