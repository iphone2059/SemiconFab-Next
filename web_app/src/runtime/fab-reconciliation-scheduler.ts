import { Duration, Effect, Exit, Option, Scope, Semaphore } from 'effect';
import type { CommandGateway } from '@/contracts/command-gateway.contract';
import type { CommandWorkflow } from '@/contracts/command-workflow.contract';
import { CommandReconciler } from '@/runtime/command-reconciler';
import type { RuntimeHost } from '@/runtime/fab-runtime-host';

export const DEFAULT_MAX_CONCURRENT_RECONCILIATIONS = 4;
export const DEFAULT_MAX_QUEUED_RECONCILIATIONS = 128;
export const DEFAULT_RECONCILIATION_TIMEOUT_MS = 10_000;
/** A dropped queued item is retried once capacity frees; this bounds that retry list. */
const MAX_OVERFLOW_RETRIES = 4_096;

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

export interface FabReconciliationSchedulerStats {
  readonly scheduled: number;
  readonly queued: number;
  readonly inFlight: number;
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
  /** Authoritative gateway; without one the scheduler resolves every schedule to false. */
  readonly gateway?: CommandGateway;
  readonly resolve: (commandId: string) => ReconciliationTarget | undefined;
  /** Terminal commands are never queued, never retried and never evicted from the queue silently. */
  readonly isTerminal: (commandId: string) => boolean;
  readonly maxConcurrent?: number;
  readonly maxQueued?: number;
  readonly timeoutMs?: number;
  /** Observability hook for queue-capacity drops (never silent). */
  readonly onDrop?: (diagnostic: ReconciliationDropDiagnostic) => void;
  /** Called after an authoritative result was delivered to the workflow (projection/terminal ownership lives in FabRuntime). */
  readonly onReconciled?: (commandId: string) => void;
}

interface ScheduledEntry {
  readonly commandId: string;
  readonly waiters: Array<(reconciled: boolean) => void>;
  settled: boolean;
  readonly promise: Promise<boolean>;
}

function scheduledEntry(commandId: string): ScheduledEntry {
  let resolve!: (reconciled: boolean) => void;
  const promise = new Promise<boolean>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { commandId, waiters: [resolve], settled: false, promise };
}

/**
 * The single authoritative-reconciliation scheduler of one FAB (ADR-007 §4).
 *
 * Every reconciliation entry point (trackCommand, replay gap, reconnect,
 * transport failure, overflow, explicit reconcileCommand/reconcileAll and the
 * recovery pass) funnels through here. One Effect Semaphore bounds the whole FAB
 * to `maxConcurrent` in-flight queries, per-command single-flight merges
 * duplicate schedules, the FIFO queue is bounded and reports capacity drops,
 * each item is timed out, and closing the scheduler Scope cancels every queued or
 * in-flight item without leaking a semaphore slot.
 */
export class FabReconciliationScheduler {
  readonly fabId: string;
  private readonly runtime: RuntimeHost;
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
  private readonly overflowRetry: string[] = [];
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
    this.schedulerScope = Scope.forkUnsafe(options.parentScope);
    this.semaphore = Semaphore.makeUnsafe(Math.max(1, options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_RECONCILIATIONS));
    this.reconciler = options.gateway ? new CommandReconciler(options.gateway) : undefined;
    this.resolveTarget = options.resolve;
    this.isTerminal = options.isTerminal;
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_RECONCILIATIONS);
    this.maxQueued = Math.max(1, options.maxQueued ?? DEFAULT_MAX_QUEUED_RECONCILIATIONS);
    this.timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_RECONCILIATION_TIMEOUT_MS);
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
    const entry = scheduledEntry(commandId);
    this.queue.push(entry);
    this.queuedById.set(commandId, entry);
    this.wake();
    return entry.promise;
  }

  /** Schedule every id and wait for the whole batch; no second worker pool exists. */
  async scheduleMany(commandIds: Iterable<string>): Promise<number> {
    const unique = [...new Set(commandIds)];
    const results = await Promise.all(unique.map((commandId) => this.schedule(commandId)));
    return results.filter(Boolean).length;
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
   * scheduler Scope and release the semaphore. Idempotent.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const queued = [...this.queue];
    this.queue.length = 0;
    this.queuedById.clear();
    this.overflowRetry.length = 0;
    for (const entry of queued) {
      this.cancelledCount += 1;
      this.settle(entry, false);
    }
    // Closing the owning Scope interrupts every in-flight item; each item's
    // ensuring clause settles its waiters and deletes its in-flight entry.
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
    this.refillOverflowRetries();
    while (this.inFlightById.size < this.maxConcurrent) {
      const entry = this.queue.shift();
      if (!entry) break;
      this.queuedById.delete(entry.commandId);
      if (entry.settled) continue;
      this.start(entry);
    }
  }

  private refillOverflowRetries(): void {
    while (this.queue.length < this.maxQueued && this.overflowRetry.length > 0) {
      const commandId = this.overflowRetry.shift();
      if (commandId === undefined) break;
      if (this.queuedById.has(commandId) || this.inFlightById.has(commandId)) continue;
      if (this.isTerminal(commandId)) continue;
      const entry = scheduledEntry(commandId);
      this.queue.push(entry);
      this.queuedById.set(commandId, entry);
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
      const outcome = yield* Effect.timeoutOption(
        Effect.promise(() =>
          reconciler.reconcile(target.workflow, self.fabId, entry.commandId, target.isCurrent).catch(() => false),
        ),
        Duration.millis(self.timeoutMs),
      );
      if (Option.isNone(outcome)) {
        self.timedOutCount += 1;
        return;
      }
      if (outcome.value) {
        self.completedCount += 1;
        self.settle(entry, true);
        self.onReconciled?.(entry.commandId);
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

  /** Drop the oldest non-terminal queued item, report it and retry it later. */
  private dropForCapacity(): void {
    const nonTerminalIndex = this.queue.findIndex((entry) => !this.isTerminal(entry.commandId));
    const index = nonTerminalIndex >= 0 ? nonTerminalIndex : 0;
    const [droppedEntry] = this.queue.splice(index, 1);
    if (!droppedEntry) return;
    this.queuedById.delete(droppedEntry.commandId);
    this.droppedCount += 1;
    this.settle(droppedEntry, false);
    if (this.overflowRetry.length >= MAX_OVERFLOW_RETRIES) this.overflowRetry.shift();
    this.overflowRetry.push(droppedEntry.commandId);
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
