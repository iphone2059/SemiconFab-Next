import { Duration, Effect, Exit, Option, Scope, Semaphore } from 'effect';
import type { CommandGateway, CommandGatewayError } from '@/contracts/command-gateway.contract';
import type { CommandWorkflow } from '@/contracts/command-workflow.contract';
import {
  CommandReconciler,
  type ReconciliationRequest,
  type ReconciliationRequestIdentity,
} from '@/runtime/command-reconciler';
import type { RuntimeHost } from '@/runtime/fab-runtime-host';
import { requirePositiveSafeInteger } from '@/runtime/numeric-configuration';

export const DEFAULT_MAX_CONCURRENT_RECONCILIATIONS = 4;
export const DEFAULT_MAX_QUEUED_RECONCILIATIONS = 128;
export const DEFAULT_RECONCILIATION_TIMEOUT_MS = 10_000;
/** ADR-011 §2.2: one FAB shares exactly four physical HTTP slots across every entry point. */
export const DEFAULT_PHYSICAL_REQUEST_BUDGET = 4;

/**
 * FAB-wide physical HTTP budget (ADR-011 §2.2). Exactly one instance exists per
 * FAB: the reconciliation scheduler and the FabRuntime recovery pipeline
 * (journal/list) acquire the same slots, so "at most 4 physical requests per FAB"
 * holds across all entry points, not per subsystem.
 */
export interface PhysicalRequestBudget {
  readonly capacity: number;
  /** Live physical requests currently holding a slot across every FAB entry point. */
  readonly inFlight: number;
  /** Runs the effect while holding one shared physical slot; always released (success/failure/interrupt). */
  readonly withPermit: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

/** Creates the single shared physical budget of one FAB (default 4, ADR-011 §2.2). */
export function createPhysicalRequestBudget(capacity: number = DEFAULT_PHYSICAL_REQUEST_BUDGET): PhysicalRequestBudget {
  const slots = requirePositiveSafeInteger('physical request capacity', capacity);
  const semaphore = Semaphore.makeUnsafe(slots);
  let inFlight = 0;
  const withPermit = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Semaphore.withPermits(semaphore, 1)(
      Effect.sync(() => {
        inFlight += 1;
      }).pipe(
        Effect.flatMap(() =>
          // The finalizer is registered only after the counter incremented, so a
          // permit-interrupt race can never decrement the counter twice.
          Effect.ensuring(
            effect,
            Effect.sync(() => {
              inFlight -= 1;
            }),
          )),
      ),
    );
  return {
    capacity: slots,
    get inFlight(): number {
      return inFlight;
    },
    withPermit,
  };
}

/** Current workflow generation for one command; undefined = unknown/terminal/evicted. */
export interface ReconciliationTarget {
  readonly workflow: CommandWorkflow;
  /** Discards a late authoritative result after eviction/FAB replacement. */
  readonly isCurrent: () => boolean;
}

export interface ReconciliationDropDiagnostic {
  readonly reason: 'queue-capacity';
  readonly commandId: string;
  readonly droppedTotal: number;
  readonly queued: number;
  readonly inFlight: number;
}

export type ReconciliationBatchOutcome =
  | 'reconciled'
  | 'terminal'
  | 'missing-target'
  | 'unavailable'
  | 'failed'
  | 'disposed';

export interface ReconciliationBatchResult {
  readonly commandId: string;
  readonly outcome: ReconciliationBatchOutcome;
}

export interface FabReconciliationSchedulerStats {
  readonly scheduled: number;
  readonly queued: number;
  /** Logical reconciliation items currently running (bounded by maxConcurrent). */
  readonly inFlight: number;
  /** Physical HTTP requests currently in flight across the whole FAB (shared budget). */
  readonly physicallyInFlight: number;
  readonly completed: number;
  readonly failed: number;
  readonly timedOut: number;
  readonly dropped: number;
  readonly cancelled: number;
}

export interface FabReconciliationSchedulerOptions {
  readonly fabId: string;
  /** Approved execution boundary (AppRuntime satisfies it structurally). */
  readonly runtime: RuntimeHost;
  /** FabScope; the scheduler forks its own ReconciliationSchedulerScope from it. */
  readonly parentScope: Scope.Scope;
  /**
   * The one physical HTTP budget of this FAB (ADR-011 §2.2). FabRuntime creates it
   * once and passes the same object to every recovery request, so reconciliation
   * and recovery share the four slots.
   */
  readonly physicalBudget: PhysicalRequestBudget;
  /** Authoritative gateway; without one the scheduler resolves every schedule to false. */
  readonly gateway?: CommandGateway;
  readonly resolve: (commandId: string) => ReconciliationTarget | undefined;
  /** Terminal commands are never queued, never retried and never evicted from the queue silently. */
  readonly isTerminal: (commandId: string) => boolean;
  readonly maxConcurrent?: number;
  readonly maxQueued?: number;
  readonly timeoutMs?: number;
  /**
   * Observability hook for queue-capacity drops (never silent). FabRuntime turns
   * this into Dirty + authoritative list recovery (ADR-010 state machine); the
   * scheduler no longer keeps a second unbounded retry list (CR-08).
   */
  readonly onDrop?: (diagnostic: ReconciliationDropDiagnostic) => void;
  /** Called after an authoritative result was delivered to the workflow (projection/terminal ownership lives in FabRuntime). */
  readonly onReconciled?: (commandId: string) => void;
}

interface ScheduledEntry {
  /** Monotonic request generation; a superseded generation must not write the actor. */
  readonly id: number;
  readonly commandId: string;
  readonly waiters: Array<(reconciled: boolean) => void>;
  settled: boolean;
  readonly promise: Promise<boolean>;
}

function scheduledEntry(id: number, commandId: string): ScheduledEntry {
  let resolve!: (reconciled: boolean) => void;
  const promise = new Promise<boolean>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { id, commandId, waiters: [resolve], settled: false, promise };
}

type ItemOutcome =
  | { readonly _tag: 'delivered' }
  | { readonly _tag: 'not-delivered' }
  | { readonly _tag: 'cancelled' }
  | { readonly _tag: 'failed'; readonly error: CommandGatewayError };

/**
 * The single authoritative-reconciliation scheduler of one FAB (ADR-007 §4,
 * ADR-011 §2.2).
 *
 * Every reconciliation entry point (trackCommand, replay gap, reconnect,
 * transport failure, overflow, explicit reconcileCommand/reconcileAll and the
 * recovery pass) funnels through here. One logical Effect Semaphore bounds the
 * FAB to `maxConcurrent` in-flight reconciliations, per-command single-flight
 * merges duplicate schedules, the FIFO queue is bounded (a capacity drop is
 * reported through onDrop and recovered by FabRuntime/authoritative list — there
 * is no hidden second retry buffer), each item is timed out around the REAL
 * reconciler Effect so interruption aborts fetch and releases the shared physical
 * permit, and closing the scheduler Scope cancels every queued or in-flight item
 * without leaking a semaphore slot.
 */
export class FabReconciliationScheduler {
  readonly fabId: string;
  private readonly runtime: RuntimeHost;
  private readonly physicalBudget: PhysicalRequestBudget;
  private readonly schedulerScope: Scope.Closeable;
  private readonly semaphore: Semaphore.Semaphore;
  private readonly reconciler?: CommandReconciler;
  private readonly resolveTarget: (commandId: string) => ReconciliationTarget | undefined;
  private readonly isTerminal: (commandId: string) => boolean;
  private readonly maxConcurrent: number;
  private readonly maxQueued: number;
  private readonly timeoutMs: number;
  private readonly onDrop?: (diagnostic: ReconciliationDropDiagnostic) => void;
  private readonly onReconciled?: (commandId: string) => void;

  private readonly queue: ScheduledEntry[] = [];
  private readonly queuedById = new Map<string, ScheduledEntry>();
  private readonly inFlightById = new Map<string, ScheduledEntry>();
  private nextEntryId = 1;
  private scheduledCount = 0;
  private completedCount = 0;
  private failedCount = 0;
  private timedOutCount = 0;
  private droppedCount = 0;
  private cancelledCount = 0;
  private wakeScheduled = false;
  private disposed = false;

  constructor(options: FabReconciliationSchedulerOptions) {
    this.fabId = options.fabId;
    this.runtime = options.runtime;
    this.physicalBudget = options.physicalBudget;
    this.schedulerScope = Scope.forkUnsafe(options.parentScope);
    this.maxConcurrent = requirePositiveSafeInteger('maxConcurrent', options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_RECONCILIATIONS);
    this.semaphore = Semaphore.makeUnsafe(this.maxConcurrent);
    this.reconciler = options.gateway ? new CommandReconciler(options.gateway) : undefined;
    this.resolveTarget = options.resolve;
    this.isTerminal = options.isTerminal;
    this.maxQueued = requirePositiveSafeInteger('maxQueued', options.maxQueued ?? DEFAULT_MAX_QUEUED_RECONCILIATIONS);
    this.timeoutMs = requirePositiveSafeInteger('timeoutMs', options.timeoutMs ?? DEFAULT_RECONCILIATION_TIMEOUT_MS);
    this.onDrop = options.onDrop;
    this.onReconciled = options.onReconciled;
  }

  /**
   * Schedule one authoritative reconciliation. Resolves true when the
   * authoritative query produced a delivered result. Duplicate schedules for the
   * same command share one in-flight promise (single-flight) or one queue entry.
   */
  schedule(commandId: string): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    this.scheduledCount += 1;
    if (this.isTerminal(commandId)) return Promise.resolve(false);
    const inFlight = this.inFlightById.get(commandId);
    if (inFlight) return inFlight.promise;
    const queued = this.queuedById.get(commandId);
    if (queued) return queued.promise;
    if (this.queue.length >= this.maxQueued) this.dropForCapacity();
    const entry = scheduledEntry(this.nextEntryId++, commandId);
    this.queue.push(entry);
    this.queuedById.set(commandId, entry);
    this.wake();
    return entry.promise;
  }

  /** Schedule every id and preserve the terminal result of every item. */
  async scheduleManyDetailed(commandIds: Iterable<string>): Promise<readonly ReconciliationBatchResult[]> {
    const unique = [...new Set(commandIds)];
    return Promise.all(unique.map(async (commandId): Promise<ReconciliationBatchResult> => {
      if (this.disposed) return { commandId, outcome: 'disposed' };
      if (this.isTerminal(commandId)) return { commandId, outcome: 'terminal' };
      if (!this.resolveTarget(commandId)) return { commandId, outcome: 'missing-target' };
      if (!this.reconciler) return { commandId, outcome: 'unavailable' };
      if (await this.schedule(commandId)) return { commandId, outcome: 'reconciled' };
      if (this.isTerminal(commandId)) return { commandId, outcome: 'terminal' };
      return { commandId, outcome: 'failed' };
    }));
  }

  /** Schedule every id and return the number of successful reconciliations. */
  async scheduleMany(commandIds: Iterable<string>): Promise<number> {
    const results = await this.scheduleManyDetailed(commandIds);
    return results.filter((result) => result.outcome === 'reconciled').length;
  }

  /** Reconcile exactly one tracked command through the shared scheduler. */
  reconcileCommand(commandId: string): Promise<boolean> {
    return this.schedule(commandId);
  }

  get stats(): FabReconciliationSchedulerStats {
    return {
      scheduled: this.scheduledCount,
      queued: this.queue.length,
      inFlight: this.inFlightById.size,
      physicallyInFlight: this.physicalBudget.inFlight,
      completed: this.completedCount,
      failed: this.failedCount,
      timedOut: this.timedOutCount,
      dropped: this.droppedCount,
      cancelled: this.cancelledCount,
    };
  }

  get disposedState(): boolean {
    return this.disposed;
  }

  /** The scheduler owns the only authoritative reconciler of this FAB (ADR-007 §4). */
  get commandReconciler(): CommandReconciler | undefined {
    return this.reconciler;
  }

  /**
   * Cancel every queued item, interrupt every in-flight fiber by closing the
   * scheduler Scope (the interruption aborts each fetch and releases its shared
   * physical permit) and release the logical semaphore. Idempotent.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const queued = [...this.queue];
    this.queue.length = 0;
    this.queuedById.clear();
    for (const entry of queued) {
      this.cancelledCount += 1;
      this.settle(entry, false);
    }
    // Closing the owning Scope interrupts every in-flight item; each item's
    // ensuring clause settles its waiters, deletes its in-flight entry and the
    // physical budget releases its permit on interruption.
    this.runtime.runSync(Scope.close(this.schedulerScope, Exit.void));
    for (const entry of [...this.inFlightById.values()]) {
      if (entry.settled) continue;
      this.cancelledCount += 1;
      this.settle(entry, false);
    }
    this.inFlightById.clear();
  }

  private wake(): void {
    if (this.wakeScheduled || this.disposed) return;
    this.wakeScheduled = true;
    queueMicrotask(() => {
      this.wakeScheduled = false;
      this.drain();
    });
  }

  private drain(): void {
    if (this.disposed) return;
    while (this.inFlightById.size < this.maxConcurrent) {
      const entry = this.queue.shift();
      if (!entry) break;
      this.queuedById.delete(entry.commandId);
      if (entry.settled) continue;
      this.start(entry);
    }
  }

  private start(entry: ScheduledEntry): void {
    this.inFlightById.set(entry.commandId, entry);
    const effect = Semaphore.withPermits(this.semaphore, 1)(this.itemEffect(entry));
    // The scheduler Scope owns the item fiber: dispose interrupts it exactly once.
    this.runtime.runSync(Effect.forkIn(effect, this.schedulerScope));
  }

  private itemEffect(entry: ScheduledEntry): Effect.Effect<void> {
    const self = this;
    return Effect.gen(function* () {
      const target = self.resolveTarget(entry.commandId);
      const reconciler = self.reconciler;
      if (!target || !reconciler) return;
      const request: ReconciliationRequest = {
        entryId: entry.id,
        isCurrent: (identity) => self.isEntryCurrent(entry, target, identity),
      };
      // ADR-011 §2.2: timeoutOption wraps the REAL reconciler Effect (never a
      // Promise), so the timeout interrupts the fiber -> tryPromise aborts the
      // fetch -> the physical budget permit is released by withPermit's ensuring.
      const outcome = yield* Effect.timeoutOption(
        self.physicalBudget.withPermit(
          reconciler.reconcile(target.workflow, self.fabId, entry.commandId, request).pipe(
            Effect.map((delivered): ItemOutcome => delivered ? { _tag: 'delivered' } : { _tag: 'not-delivered' }),
            Effect.catch((error: CommandGatewayError): Effect.Effect<ItemOutcome> =>
              Effect.succeed(error._tag === 'CommandRequestAborted'
                ? { _tag: 'cancelled' }
                : { _tag: 'failed', error })),
          ),
        ),
        Duration.millis(self.timeoutMs),
      );
      if (Option.isNone(outcome)) {
        self.timedOutCount += 1;
        return;
      }
      const result = outcome.value;
      if (result._tag === 'delivered') {
        self.completedCount += 1;
        self.settle(entry, true);
        self.onReconciled?.(entry.commandId);
        return;
      }
      if (result._tag === 'cancelled') {
        self.cancelledCount += 1;
        return;
      }
      self.failedCount += 1;
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          self.inFlightById.delete(entry.commandId);
          if (!entry.settled) {
            if (self.disposed) self.cancelledCount += 1;
            self.settle(entry, false);
          }
          self.wake();
        }),
      ),
    );
  }

  /** The request may write only while its workflow AND scheduler entry generation are current. */
  private isEntryCurrent(
    entry: ScheduledEntry,
    target: ReconciliationTarget,
    identity: ReconciliationRequestIdentity,
  ): boolean {
    if (this.disposed) return false;
    if (identity.entryId !== entry.id) return false;
    if (identity.commandId !== entry.commandId) return false;
    if (this.inFlightById.get(entry.commandId) !== entry) return false;
    return target.isCurrent();
  }

  /**
   * Drop the oldest non-terminal queued item and report it. There is deliberately
   * no hidden overflow retry buffer: the drop is durable intent only when the
   * consumer (FabRuntime) enters Dirty and performs authoritative list recovery
   * (ADR-010 §4, ADR-011 §2.2, CR-08).
   */
  private dropForCapacity(): void {
    const nonTerminalIndex = this.queue.findIndex((entry) => !this.isTerminal(entry.commandId));
    const index = nonTerminalIndex >= 0 ? nonTerminalIndex : 0;
    const [droppedEntry] = this.queue.splice(index, 1);
    if (!droppedEntry) return;
    this.queuedById.delete(droppedEntry.commandId);
    this.droppedCount += 1;
    this.settle(droppedEntry, false);
    this.onDrop?.({
      reason: 'queue-capacity',
      commandId: droppedEntry.commandId,
      droppedTotal: this.droppedCount,
      queued: this.queue.length,
      inFlight: this.inFlightById.size,
    });
  }

  private settle(entry: ScheduledEntry, reconciled: boolean): void {
    if (entry.settled) return;
    entry.settled = true;
    const waiters = entry.waiters.splice(0);
    for (const waiter of waiters) waiter(reconciled);
  }
}
