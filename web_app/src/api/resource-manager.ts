import { Cause, Duration, Effect, Exit, Fiber, Option, Scope } from 'effect';
import * as AsyncResult from 'effect/reactivity/AsyncResult';
import * as Atom from 'effect/reactivity/Atom';
import {
  ResourceCapacityError,
  ResourceDefinitionConflictError,
  type CommitDecision,
  type IgnoreReason,
  type ResourceCommitContext,
  type ResourceDefinition,
  type ResourceDefinitionConflictField,
  type ResourceDiagnostic,
  type ResourceHandle,
  type ResourceIdentity,
  type ResourceInFlight,
  type ResourceKey,
  type ResourceManager,
  type ResourceManagerHost,
  type ResourceManagerStats,
  type ResourcePolicy,
  type ResourceRuntime,
} from '@/api/resource';

type AnyResult = AsyncResult.AsyncResult<unknown, unknown>;
type AnyWritable = Atom.Writable<AnyResult, AnyResult>;

/**
 * ADR-013 §1.3: a single hard capacity. Reaching it first evicts zero-subscriber
 * entries by idle-LRU order; if no space is reclaimed the new identity is rejected.
 * There is no second, unreachable waterline.
 */
const MAX_ENTRIES = 256;
/** ADR-006 §2.4.6: bounded Ignore diagnostics (newest last). */
const MAX_DIAGNOSTICS = 32;

type TimerHandle = ReturnType<typeof setTimeout>;

const unrefTimer = (timer: TimerHandle): void => {
  const candidate = timer as TimerHandle & { readonly unref?: () => void };
  candidate.unref?.();
};

const disposeError = (): Error => new Error('AppRuntime is disposed');
const scopeClosedError = (key: ResourceKey): Error => new Error('Resource scope is closed: ' + key);

interface ManagerEntry {
  readonly key: ResourceKey;
  /** Typed identity admitted at creation; every later handle() must be compatible. */
  readonly identity: ResourceIdentity;
  readonly definition: ResourceDefinition<unknown, unknown>;
  readonly atom: AnyWritable;
  readonly handle: ResourceHandle<unknown, unknown>;
  subscribers: number;
  requestIdCounter: number;
  currentRequestId: number;
  writeSeq: number;
  lastWriteRequestId: number | undefined;
  inFlight: ResourceInFlight | undefined;
  scope: Scope.Closeable | undefined;
  scopeGeneration: number;
  pollFiber: Fiber.Fiber<unknown, unknown> | undefined;
  polling: boolean;
  idleTimer: TimerHandle | undefined;
  idleAt: number | undefined;
  removed: boolean;
  accessSeq: number;
}

/**
 * Creates the single per-AppRuntime resource manager (ADR-006 §2.2–§2.8).
 *
 * Ownership summary:
 * - the manager owns one coordination entry per canonical ResourceKey;
 * - the entry's Atom (created here, registered by the runtime registry) is the
 *   only snapshot owner; the entry stores control metadata only;
 * - a resource scope (child of AppRuntime.rootScope) owns the poll fiber and is
 *   created by the first subscriber, closed by the last release/idle TTL;
 * - every write goes through the synchronous Publish | Ignore commit function.
 */
export function createResourceManager<Runtime extends ResourceRuntime>(
  host: ResourceManagerHost<Runtime>,
): ResourceManager<Runtime> {
  const entries = new Map<ResourceKey, ManagerEntry>();
  const entriesByHandle = new WeakMap<object, ManagerEntry>();
  const diagnostics: ResourceDiagnostic[] = [];
  let disposed = false;
  let accessCounter = 0;

  const isDisposed = (): boolean => disposed || host.isDisposed();

  const record = (
    key: ResourceKey,
    origin: ResourceDiagnostic['origin'],
    reason: IgnoreReason,
    requestId?: number,
  ): void => {
    diagnostics.push(requestId === undefined ? { key, origin, reason } : { key, origin, reason, requestId });
    if (diagnostics.length > MAX_DIAGNOSTICS) diagnostics.splice(0, diagnostics.length - MAX_DIAGNOSTICS);
  };

  const ignore = <A>(
    key: ResourceKey,
    origin: ResourceDiagnostic['origin'],
    reason: IgnoreReason,
    requestId?: number,
  ): CommitDecision<A> => {
    record(key, origin, reason, requestId);
    return { _tag: 'Ignore', reason };
  };

  const touch = (entry: ManagerEntry): void => {
    accessCounter += 1;
    entry.accessSeq = accessCounter;
  };

  const currentSuccess = (entry: ManagerEntry): Option.Option<AsyncResult.Success<unknown, unknown>> => {
    const current = host.registry.get(entry.atom);
    if (AsyncResult.isSuccess(current)) return Option.some(current);
    if (AsyncResult.isFailure(current)) return current.previousSuccess;
    return Option.none();
  };

  const writeAccepted = (entry: ManagerEntry, value: unknown, requestId: number | undefined): void => {
    entry.writeSeq += 1;
    entry.lastWriteRequestId = requestId;
    host.registry.set(entry.atom, AsyncResult.success<unknown, unknown>(value));
  };

  const clearIdleTimer = (entry: ManagerEntry): void => {
    if (entry.idleTimer !== undefined) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = undefined;
    }
  };

  const closeScope = (entry: ManagerEntry): void => {
    const scope = entry.scope;
    entry.scope = undefined;
    if (!scope) return;
    const finalizer = Scope.closeUnsafe(scope, Exit.void);
    if (finalizer) void host.services.runPromise(finalizer).catch(() => undefined);
  };

  const stopPolling = (entry: ManagerEntry): void => {
    entry.polling = false;
    // ADR-013 §1.4: releasing the poll owner invalidates every fork callback that
    // captured the previous ResourceScope generation.
    entry.scopeGeneration += 1;
    const fiber = entry.pollFiber;
    entry.pollFiber = undefined;
    if (fiber) void host.services.runPromise(Fiber.interrupt(fiber)).catch(() => undefined);
  };

  const releaseEntry = (entry: ManagerEntry): void => {
    if (entry.removed) return;
    entry.removed = true;
    entry.subscribers = 0;
    clearIdleTimer(entry);
    stopPolling(entry);
    const inFlight = entry.inFlight;
    entry.inFlight = undefined;
    inFlight?.interrupt();
    closeScope(entry);
    if (entries.get(entry.key) === entry) entries.delete(entry.key);
  };

  const armIdleTimer = (entry: ManagerEntry): void => {
    clearIdleTimer(entry);
    if (isDisposed() || entry.removed) return;
    const ttl = entry.definition.policy.idleTtlMs;
    if (!Number.isFinite(ttl) || ttl <= 0) return;
    entry.idleAt = Date.now();
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = undefined;
      if (entry.removed || entry.subscribers !== 0) return;
      if (entry.inFlight) {
        armIdleTimer(entry);
        return;
      }
      releaseEntry(entry);
    }, ttl);
    unrefTimer(entry.idleTimer);
  };

  /**
   * STREAM: the only polling owner. A ResourceScope owns exactly one fiber per
   * key; the loop only calls refresh (itself single-flight). No component timer.
   */
  const startPolling = (entry: ManagerEntry): void => {
    const pollMs = entry.definition.policy.pollMs;
    // Synchronous ownership guard: fork resolution is async, so pollFiber alone
    // cannot prevent a second retain in the same tick from forking a second loop.
    if (pollMs === undefined || entry.polling || !entry.scope) return;
    if (!Number.isFinite(pollMs) || pollMs <= 0) return;
    entry.polling = true;
    const scope = entry.scope;
    const startedGeneration = entry.scopeGeneration;
    const loop = Effect.gen(function* () {
      while (!isDisposed() && !entry.removed) {
        yield* Effect.sleep(pollMs);
        if (isDisposed() || entry.removed) break;
        yield* Effect.promise(() => refreshEntry(entry).catch(() => undefined));
      }
    });
    const fiberPromise = host.services.runPromise(Effect.forkIn(loop, scope));
    void fiberPromise
      .then((fiber) => {
        // ADR-013 §1.4: a resolved fork is the poll owner only if the same entry,
        // the same polling intent, the same generation and the same ResourceScope
        // are still current. Anything else is a stale fiber: interrupt, never store.
        const stale = entry.removed ||
          !entry.polling ||
          entry.scopeGeneration !== startedGeneration ||
          entry.scope !== scope;
        if (stale) {
          void host.services.runPromise(Fiber.interrupt(fiber)).catch(() => undefined);
          return;
        }
        entry.pollFiber = fiber;
      })
      .catch(() => { entry.polling = false; });
  };

  const ensureCapacity = (key: ResourceKey): void => {
    if (entries.size < MAX_ENTRIES) return;
    // ADR-013 §1.3: reaching the single hard limit first releases zero-subscriber
    // entries by idle LRU order; only entries that cannot be freed force a rejection.
    const evictable = [...entries.values()]
      .filter((candidate) => candidate.subscribers === 0)
      .sort((left, right) => left.accessSeq - right.accessSeq);
    for (const candidate of evictable) {
      if (entries.size < MAX_ENTRIES) break;
      releaseEntry(candidate);
    }
    if (entries.size >= MAX_ENTRIES) {
      record(key, 'read', 'capacity');
      throw new ResourceCapacityError(key, entries.size);
    }
  };

  const createEntry = (definition: ResourceDefinition<unknown, unknown>): ManagerEntry => {
    const writable = Atom.writable<AnyResult, AnyResult>(
      () => AsyncResult.initial<unknown, unknown>(),
      (context, value) => context.setSelf(value),
    ).pipe(Atom.setIdleTTL(Duration.millis(definition.policy.idleTtlMs)));
    const handle: ResourceHandle<unknown, unknown> = { key: definition.identity.key, atom: writable, definition };
    const entry: ManagerEntry = {
      key: definition.identity.key,
      identity: definition.identity,
      definition,
      atom: writable,
      handle,
      subscribers: 0,
      requestIdCounter: 0,
      currentRequestId: 0,
      writeSeq: 0,
      lastWriteRequestId: undefined,
      inFlight: undefined,
      scope: undefined,
      scopeGeneration: 0,
      pollFiber: undefined,
      polling: false,
      idleTimer: undefined,
      idleAt: undefined,
      removed: false,
      accessSeq: 0,
    };
    touch(entry);
    entries.set(entry.key, entry);
    entriesByHandle.set(handle, entry);
    armIdleTimer(entry);
    return entry;
  };

  /**
   * ADR-013 §1.2: a same-key definition must match the admitted typed identity
   * (kind/version/key) and the policy contract; otherwise throw instead of
   * silently reusing an unrelated Atom. A TTL-released key may be recreated with a
   * different identity because the entry no longer exists.
   */
  const assertDefinitionCompatible = (
    entry: ManagerEntry,
    incoming: ResourceIdentity,
    candidatePolicy: ResourcePolicy,
  ): void => {
    const existing = entry.identity;
    const conflict = (field: ResourceDefinitionConflictField): never => {
      throw new ResourceDefinitionConflictError(incoming.key, existing, incoming, field);
    };
    if (existing.kind !== incoming.kind) conflict('kind');
    if (existing.version !== incoming.version) conflict('version');
    if (existing.key !== incoming.key) conflict('key');
    const admitted = entry.definition.policy;
    if (admitted.freshnessMs !== candidatePolicy.freshnessMs ||
        admitted.idleTtlMs !== candidatePolicy.idleTtlMs ||
        admitted.pollMs !== candidatePolicy.pollMs) {
      conflict('policy');
    }
  };

  const resolveEntry = (handle: object): ManagerEntry | undefined => entriesByHandle.get(handle);

  const ensureEntry = (entry: ManagerEntry): Promise<unknown> => {
    if (isDisposed()) return Promise.reject(disposeError());
    if (entry.removed) return Promise.reject(scopeClosedError(entry.key));
    touch(entry);
    const current = host.registry.get(entry.atom);
    if (AsyncResult.isSuccess(current)) {
      const age = Date.now() - current.timestamp;
      if (age < entry.definition.policy.freshnessMs) return Promise.resolve(current.value);
    }
    return refreshEntry(entry);
  };

  const refreshEntry = (entry: ManagerEntry): Promise<unknown> => {
    if (isDisposed()) return Promise.reject(disposeError());
    if (entry.removed) return Promise.reject(scopeClosedError(entry.key));
    if (entry.inFlight) return entry.inFlight.promise;
    touch(entry);
    entry.requestIdCounter += 1;
    const requestId = entry.requestIdCounter;
    entry.currentRequestId = requestId;
    const baselineWriteSeq = entry.writeSeq;
    const current = host.registry.get(entry.atom);
    // Refreshing is a control-state transition, not a payload publication: the
    // retained value and its timestamp stay exactly the same while waiting.
    if (AsyncResult.isSuccess(current)) {
      host.registry.set(entry.atom, AsyncResult.success(current.value, { waiting: true, timestamp: current.timestamp }));
    }
    const fiber = host.services.runFork(entry.definition.load);
    const interrupt = (): void => {
      void host.services.runPromise(Fiber.interrupt(fiber)).catch(() => undefined);
    };
    const promise: Promise<unknown> = host.services
      .runPromise(Fiber.await(fiber))
      .then((exit) => {
        if (Exit.isSuccess(exit)) {
          commitReadSuccess(entry, exit.value, requestId, baselineWriteSeq);
          return exit.value;
        }
        const error = Cause.squash(exit.cause);
        commitReadFailure(entry, error, requestId, baselineWriteSeq);
        throw error;
      })
      .finally(() => {
        if (entry.inFlight?.requestId === requestId) entry.inFlight = undefined;
      });
    entry.inFlight = { requestId, promise, interrupt };
    return promise;
  };

  const commitReadSuccess = (
    entry: ManagerEntry,
    value: unknown,
    requestId: number,
    baselineWriteSeq: number,
  ): CommitDecision<unknown> => {
    if (isDisposed()) return ignore(entry.key, 'read', 'disposed', requestId);
    if (entry.removed) return ignore(entry.key, 'read', 'scope-closed', requestId);
    if (entry.currentRequestId !== requestId) return ignore(entry.key, 'read', 'stale-request', requestId);
    const current = host.registry.get(entry.atom);
    const superseded = baselineWriteSeq !== entry.writeSeq;
    const context: ResourceCommitContext<unknown> = {
      current,
      origin: 'read',
      requestId,
      baselineWriteSeq,
      writeSeq: entry.writeSeq,
      scopeGeneration: entry.scopeGeneration,
    };
    let next = value;
    if (entry.definition.accept) {
      // ADR-013 §1.1: version/epoch-aware resources still decide for themselves
      // (a genuinely newer read may win; stale device frames are rejected there).
      const decision = entry.definition.accept(value, context);
      if (decision._tag === 'Ignore') {
        record(entry.key, 'read', decision.reason, requestId);
        return decision;
      }
      next = decision.value;
    } else if (superseded) {
      // ADR-013 §1.1 / CR-05: a generic GET that started before an accepted
      // mutation/recovery write must never overwrite that newer authoritative value.
      return ignore(entry.key, 'read', 'superseded-write', requestId);
    }
    writeAccepted(entry, next, requestId);
    return { _tag: 'Publish', value: next };
  };

  const commitReadFailure = (
    entry: ManagerEntry,
    error: unknown,
    requestId: number,
    baselineWriteSeq: number,
  ): void => {
    if (isDisposed()) {
      record(entry.key, 'read', 'disposed', requestId);
      return;
    }
    if (entry.removed) {
      record(entry.key, 'read', 'scope-closed', requestId);
      return;
    }
    if (entry.currentRequestId !== requestId) {
      record(entry.key, 'read', 'stale-request', requestId);
      return;
    }
    if (baselineWriteSeq !== entry.writeSeq) {
      // A newer accepted write (SSE push / mutation / recovery) owns the Atom:
      // the stale failure must only produce a diagnostic (CORE-004).
      record(entry.key, 'read', 'superseded-write', requestId);
      return;
    }
    const previous = currentSuccess(entry);
    host.registry.set(entry.atom, AsyncResult.failWithPrevious<unknown, unknown>(error, { previous }));
  };

  const manager: ResourceManager<Runtime> = {
    runtime: host.runtime,
    handle<A, E>(definition: ResourceDefinition<A, E>): ResourceHandle<A, E> {
      if (isDisposed()) throw disposeError();
      const existing = entries.get(definition.identity.key);
      if (existing) {
        touch(existing);
        assertDefinitionCompatible(existing, definition.identity, definition.policy);
        // R14 justification: manager entries store handles with erased type parameters (the
        // manager is the only owner; A/E are compile-time-only and cannot be recovered from a Map).
        return existing.handle as unknown as ResourceHandle<A, E>;
      }
      ensureCapacity(definition.identity.key);
      // R14 justification: the entry map is heterogeneous by design; the definition's load/accept
      // closures keep their concrete A/E through the closure, and every public handle() call
      // restores the caller's A/E at this single type-erasure boundary.
      const entry = createEntry(definition as unknown as ResourceDefinition<unknown, unknown>);
      // R14 justification: same single type-erasure boundary as above; the entry's handle is
      // manager-owned and the caller's concrete A/E is restored here.
      return entry.handle as unknown as ResourceHandle<A, E>;
    },
    state<A, E>(handle: ResourceHandle<A, E>): AsyncResult.AsyncResult<A, E> {
      return host.registry.get(handle.atom);
    },
    value<A, E>(handle: ResourceHandle<A, E>): A | undefined {
      return Option.getOrUndefined(AsyncResult.value(host.registry.get(handle.atom)));
    },
    ensure<A, E>(handle: ResourceHandle<A, E>): Promise<A> {
      const entry = resolveEntry(handle);
      if (!entry) return Promise.reject(scopeClosedError(handle.key));
      return ensureEntry(entry) as Promise<A>;
    },
    refresh<A, E>(handle: ResourceHandle<A, E>): Promise<A> {
      const entry = resolveEntry(handle);
      if (!entry) return Promise.reject(scopeClosedError(handle.key));
      return refreshEntry(entry) as Promise<A>;
    },
    publish<A, E>(
      handle: ResourceHandle<A, E>,
      value: A,
      origin: 'push' | 'mutation' | 'recovery' = 'push',
    ): CommitDecision<A> {
      if (isDisposed()) return ignore<A>(handle.key, origin, 'disposed');
      const entry = resolveEntry(handle);
      if (!entry || entry.removed) return ignore<A>(handle.key, origin, 'scope-closed');
      touch(entry);
      const current = host.registry.get(entry.atom);
      const context: ResourceCommitContext<unknown> = {
        current,
        origin,
        requestId: undefined,
        baselineWriteSeq: entry.writeSeq,
        writeSeq: entry.writeSeq,
        scopeGeneration: entry.scopeGeneration,
      };
      let next: unknown = value;
      if (entry.definition.accept) {
        const decision = entry.definition.accept(value as unknown, context);
        if (decision._tag === 'Ignore') {
          record(entry.key, origin, decision.reason);
          return decision as CommitDecision<A>;
        }
        next = decision.value;
      }
      writeAccepted(entry, next, undefined);
      return { _tag: 'Publish', value: next as A };
    },
    retain<A, E>(handle: ResourceHandle<A, E>): () => void {
      if (isDisposed()) return () => undefined;
      const entry = resolveEntry(handle);
      if (!entry || entry.removed) return () => undefined;
      entry.subscribers += 1;
      touch(entry);
      clearIdleTimer(entry);
      entry.idleAt = undefined;
      if (!entry.scope) {
        entry.scope = Scope.forkUnsafe(host.rootScope);
        entry.scopeGeneration += 1;
      }
      startPolling(entry);
      // ADR-006 §2.6: the first subscriber triggers one freshness-checked ensure.
      void ensureEntry(entry).catch(() => undefined);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (entry.removed) return;
        entry.subscribers = Math.max(0, entry.subscribers - 1);
        if (entry.subscribers > 0) return;
        stopPolling(entry);
        closeScope(entry);
        armIdleTimer(entry);
      };
    },
    release(key: ResourceKey): void {
      const entry = entries.get(key);
      if (entry) releaseEntry(entry);
    },
    get diagnostics(): readonly ResourceDiagnostic[] {
      return [...diagnostics];
    },
    get stats(): ResourceManagerStats {
      let inFlight = 0;
      let polling = 0;
      let scopes = 0;
      for (const entry of entries.values()) {
        if (entry.inFlight) inFlight += 1;
        if (entry.polling) polling += 1;
        if (entry.scope && entry.scope.state._tag !== 'Closed') scopes += 1;
      }
      return { entries: entries.size, inFlight, polling, scopes };
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const entry of [...entries.values()]) releaseEntry(entry);
      entries.clear();
    },
  };

  return manager;
}