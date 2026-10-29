import { Effect, Exit, Scope } from 'effect';
import type * as Fiber from 'effect/Fiber';
import type * as AtomRegistry from 'effect/reactivity/AtomRegistry';
import type {
  CommandConnectionStatus,
  CommandEventSource,
  CommandResultEvent,
  CommandStreamDirty,
  CommandTransportFailure,
} from '@/contracts/command-events.contract';
import type {
  CommandGateway,
  CommandJournalEvent,
  CommandJournalPage,
  CommandRecoveryList,
} from '@/contracts/command-gateway.contract';
import type { CommandOutcome } from '@/contracts/command-events.contract';
import type {
  CommandWorkflow,
  CommandWorkflowProjection,
  CommandWorkflowRegistry,
} from '@/contracts/command-workflow.contract';
import { CommandCorrelationRegistry } from '@/runtime/command-correlation-registry';
import { CommandEventBridge } from '@/runtime/command-event-bridge';
import type { CommandRecoveryEviction } from '@/runtime/command-event-recovery';
import { CommandEventRecovery } from '@/runtime/command-event-recovery';
import { CommandProjectionStore, type CommandProjectionAtom } from '@/runtime/command-projection.store';
import {
  FabReconciliationScheduler,
  type FabReconciliationSchedulerStats,
  type ReconciliationDropDiagnostic,
} from '@/runtime/fab-reconciliation-scheduler';
import type { RuntimeHost } from '@/runtime/fab-runtime-host';
import { runCommandStream, stopCommandStream } from '@/runtime/command-stream';
import { XStateCommandWorkflowAdapter } from '@/runtime/xstate-command-workflow-adapter';

export type CommandWorkflowFactory = (fabId: string, commandId: string) => CommandWorkflow;

/** Terminal-state retention for workflows, projections and correlation watermarks. */
export interface FabRuntimeRetentionOptions {
  /** Keep a terminal workflow alive (and its actor disposable) for this long. */
  readonly terminalTtlMs?: number;
  /** Hard cap on retained terminal workflows; the oldest terminal entries go first. */
  readonly maxTerminalWorkflows?: number;
  /** Hard cap on read-only projections kept after a workflow is evicted. */
  readonly maxRetainedProjections?: number;
  /** Sweep cadence; also bounded by the next terminal expiry. */
  readonly sweepIntervalMs?: number;
  /** Test seam; production uses Date.now. */
  readonly now?: () => number;
}

export interface FabRuntimeOptions {
  /** FAB identity is composite: (siteId, fabId) (ADR-007 §3). */
  readonly siteId: string;
  readonly fabId: string;
  /** Approved execution boundary (AppRuntime satisfies it structurally). */
  readonly runtime: RuntimeHost;
  /** AppScope: FabRuntime forks its FabScope from this parent (ADR-007 §2). */
  readonly parentScope: Scope.Scope;
  /**
   * Required: the same AtomRegistry React reads. There is no fallback path and no
   * second projection source (ADR-007 §6).
   */
  readonly projectionRegistry: AtomRegistry.AtomRegistry;
  /**
   * Creates the per-FAB command event source; the FabRuntime passes the
   * CommandTransportScope that owns the EventSource and consumer fibers.
   */
  readonly sourceFor: (fabId: string, scope: Scope.Scope) => CommandEventSource;
  readonly gateway?: CommandGateway;
  /** Test seam; production defaults to XStateCommandWorkflowAdapter. */
  readonly createWorkflow?: CommandWorkflowFactory;
  /** Test seam for retention bounds/clock; production keeps the defaults. */
  readonly retention?: FabRuntimeRetentionOptions;
  /** Defer opening the command SSE stream until the first command is tracked. */
  readonly lazyCommandSubscription?: boolean;
  /** Bound on simultaneous authoritative reconciliations per FAB (target 4). */
  readonly maxConcurrentReconciliations?: number;
  /** Bound on queued reconciliations per FAB (target 128, drop + diagnostic). */
  readonly maxQueuedReconciliations?: number;
  /** Per-item reconciliation timeout (target 10s). */
  readonly reconcileTimeoutMs?: number;
}

interface ResolvedRetention {
  readonly terminalTtlMs: number;
  readonly maxTerminalWorkflows: number;
  readonly maxRetainedProjections: number;
  readonly sweepIntervalMs: number;
  readonly now: () => number;
}

const DEFAULT_RETENTION: ResolvedRetention = {
  terminalTtlMs: 300_000,
  maxTerminalWorkflows: 64,
  maxRetainedProjections: 128,
  sweepIntervalMs: 15_000,
  now: Date.now,
};

function resolveRetention(options: FabRuntimeRetentionOptions | undefined): ResolvedRetention {
  return {
    terminalTtlMs: Math.max(0, options?.terminalTtlMs ?? DEFAULT_RETENTION.terminalTtlMs),
    maxTerminalWorkflows: Math.max(1, options?.maxTerminalWorkflows ?? DEFAULT_RETENTION.maxTerminalWorkflows),
    maxRetainedProjections: Math.max(0, options?.maxRetainedProjections ?? DEFAULT_RETENTION.maxRetainedProjections),
    sweepIntervalMs: Math.max(1, options?.sweepIntervalMs ?? DEFAULT_RETENTION.sweepIntervalMs),
    now: options?.now ?? DEFAULT_RETENTION.now,
  };
}

const TERMINAL_OUTCOMES: ReadonlySet<CommandOutcome> = new Set(['succeeded', 'failed', 'cancelled']);
const isTerminalOutcome = (outcome: CommandOutcome | 'pending' | undefined): boolean =>
  outcome !== undefined && outcome !== 'pending' && TERMINAL_OUTCOMES.has(outcome);

interface JournalCursor {
  readonly epoch?: string;
  readonly sequence?: number;
}

interface RecoveryRequest {
  readonly journal?: JournalCursor;
  readonly list: boolean;
}

export interface FabRuntimeLifecycleCounts {
  /** Workflows acquired through Effect.acquireRelease (CommandScope). */
  readonly created: number;
  /** Workflow finalizers that ran exactly once. */
  readonly finalized: number;
}

/**
 * Per-FAB command runtime (ADR-007 §2/§3): the only assembly point of the
 * realtime source, the CommandEventBridge, the authoritative scheduler and the
 * XState workflows.
 *
 * Scope tree owned here:
 *   FabScope
 *     ├── CommandTransportScope   (EventSource + every signal/command consumer fiber)
 *     ├── ReconciliationSchedulerScope (scheduler-owned; one scheduler per FAB)
 *     └── CommandScope(commandId) (XState actor acquired with Effect.acquireRelease)
 *
 * Every reconciliation entry point funnels through the single scheduler; terminal
 * eviction closes the command's Scope so its finalizer runs exactly once; dispose
 * closes the children then the FabScope. Read-only projections live in one
 * bounded CommandProjectionStore written only by this class.
 */
export class FabRuntime {
  readonly siteId: string;
  readonly fabId: string;

  private readonly runtime: RuntimeHost;
  private readonly fabScope: Scope.Closeable;
  private readonly transportScope: Scope.Closeable;
  private readonly source: CommandEventSource;
  private readonly gateway?: CommandGateway;
  private readonly projectionStore: CommandProjectionStore;
  private readonly scheduler: FabReconciliationScheduler;
  private readonly bridge: CommandEventBridge;
  private readonly correlation: CommandCorrelationRegistry;
  private readonly recovery: CommandEventRecovery;
  private readonly createWorkflow: CommandWorkflowFactory;
  private readonly lazyCommandSubscription: boolean;
  private readonly retention: ResolvedRetention;

  private readonly workflows = new Map<string, CommandWorkflow>();
  private readonly commandScopes = new Map<string, Scope.Closeable>();
  private readonly terminalAt = new Map<string, number>();
  private readonly projectionSubscriptions = new Map<string, () => void>();
  private readonly signalFibers: Array<Fiber.Fiber<void, never>> = [];

  private started = false;
  private disposed = false;
  private bridgeStarted = false;
  private sweepTimer?: ReturnType<typeof setTimeout>;
  private passScheduled = false;
  private passRunning = false;
  private passPending = false;
  private recoveryRequest: RecoveryRequest | undefined;
  private gapObserved = false;
  private connectionStatus: CommandConnectionStatus = 'connecting';
  private lastTransportFailure?: CommandTransportFailure;
  private lastDirty?: CommandStreamDirty;
  private lastEviction?: CommandRecoveryEviction;
  private lastDrop?: ReconciliationDropDiagnostic;
  private lastJournalPageValue?: CommandJournalPage;
  private lastRecoveryListValue?: CommandRecoveryList;
  private createdWorkflows = 0;
  private finalizedWorkflows = 0;

  constructor(options: FabRuntimeOptions) {
    this.siteId = options.siteId;
    this.fabId = options.fabId;
    this.runtime = options.runtime;
    this.gateway = options.gateway;
    this.lazyCommandSubscription = options.lazyCommandSubscription === true;
    this.retention = resolveRetention(options.retention);

    // FabScope is the only Scope this class closes; its children are created from it.
    this.fabScope = Scope.forkUnsafe(options.parentScope);
    this.transportScope = Scope.forkUnsafe(this.fabScope);
    this.projectionStore = new CommandProjectionStore({
      registry: options.projectionRegistry,
      maxRetained: this.retention.maxRetainedProjections,
    });
    this.recovery = new CommandEventRecovery({
      onEvict: (eviction) => {
        this.lastEviction = eviction;
        // A capacity eviction may have lost a revision; converge from the
        // authoritative backend through the single scheduler.
        this.gapObserved = true;
        this.requestRecovery({ list: false });
      },
    });
    this.correlation = new CommandCorrelationRegistry({
      maxTerminalEntries: this.retention.maxTerminalWorkflows,
      terminalTtlMs: this.retention.terminalTtlMs,
      now: this.retention.now,
    });
    this.scheduler = new FabReconciliationScheduler({
      fabId: options.fabId,
      runtime: options.runtime,
      parentScope: this.fabScope,
      gateway: options.gateway,
      resolve: (commandId) => this.resolveReconciliationTarget(commandId),
      isTerminal: (commandId) => this.isTerminalCommand(commandId),
      maxConcurrent: options.maxConcurrentReconciliations,
      maxQueued: options.maxQueuedReconciliations,
      timeoutMs: options.reconcileTimeoutMs,
      onDrop: (diagnostic) => {
        this.lastDrop = diagnostic;
        this.gapObserved = true;
      },
      onReconciled: (commandId) => this.afterDelivery(commandId),
    });
    const reconciler = this.scheduler.commandReconciler;
    this.createWorkflow = options.createWorkflow ??
      ((fabId, commandId) => new XStateCommandWorkflowAdapter(fabId, commandId, reconciler));
    this.source = options.sourceFor(options.fabId, this.transportScope);
    const registry: CommandWorkflowRegistry = {
      get: (fabId, commandId) => (fabId === this.fabId ? this.workflows.get(commandId) : undefined),
    };
    this.bridge = new CommandEventBridge(this.source, registry, {
      fabId: options.fabId,
      correlation: this.correlation,
      recovery: this.recovery,
      onResultDelivered: (event) => { this.afterDelivery(event.commandId); },
      runtime: options.runtime,
      scope: this.transportScope,
    });
  }

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.subscribeSignals();
    if (!this.lazyCommandSubscription || this.workflows.size > 0) {
      this.bridge.start();
      this.bridgeStarted = true;
    }
    // Startup/refresh recovery: list the FAB's active commands from the durable
    // authority, track the ones this page did not submit, then reconcile them.
    this.requestRecovery({ list: true });
    this.scheduleSweep();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.bridgeStarted) {
      this.bridge.stop();
      this.bridgeStarted = false;
    }
    for (const fiber of this.signalFibers) stopCommandStream(this.runtime, fiber);
    this.signalFibers.length = 0;
    this.clearSweepTimer();
  }

  /** Create the workflow for a submitted command; replays results held before registration. */
  trackCommand(commandId: string): CommandWorkflow {
    if (this.disposed) throw new Error('FAB runtime is disposed');
    const existing = this.workflows.get(commandId);
    if (existing) return existing;
    const commandScope = Scope.forkUnsafe(this.fabScope);
    const factory = this.createWorkflow;
    let workflow: CommandWorkflow;
    try {
      // Per-command CommandScope: the actor and every command-owned task live
      // inside it; the finalizer runs exactly once when the Scope closes (ADR-007 §2).
      workflow = this.runtime.runSync(
        Effect.provideService(
          Effect.acquireRelease(
            Effect.sync(() => {
              this.createdWorkflows += 1;
              return factory(this.fabId, commandId);
            }),
            (created) =>
              Effect.sync(() => {
                this.finalizedWorkflows += 1;
                created.dispose();
              }),
          ),
          Scope.Scope,
          commandScope,
        ),
      );
    } catch (cause) {
      this.runtime.runSync(Scope.close(commandScope, Exit.void));
      throw cause;
    }
    this.workflows.set(commandId, workflow);
    this.commandScopes.set(commandId, commandScope);
    this.projectionStore.pin(commandId);
    // Seed the initial projection, then subscribe, then start: no first frame is lost.
    this.publishProjection(commandId);
    this.subscribeProjection(commandId, workflow);
    this.startWorkflow(workflow);
    if (!this.bridgeStarted && this.started && !this.disposed) {
      this.bridge.start();
      this.bridgeStarted = true;
    }
    this.bridge.flushRecovery();
    this.afterDelivery(commandId);
    const revision = workflow.projection?.revision ?? -1;
    if (this.gapObserved || !this.hasLocalEvidence(commandId) || revision < 0) {
      void this.scheduler.schedule(commandId);
    }
    return workflow;
  }

  getWorkflow(commandId: string): CommandWorkflow | undefined {
    return this.workflows.get(commandId);
  }

  /** Stable read-only Atom for one command; React reads it, FabRuntime writes it. */
  projectionAtom(commandId: string): CommandProjectionAtom {
    return this.projectionStore.atomFor(commandId);
  }

  /** True when realtime events (or held recovery events) were observed for the command. */
  hasLocalEvidence(commandId: string): boolean {
    return this.correlation.lastRevision(this.fabId, commandId) !== undefined ||
      this.bridge.recoveryQueue.pendingFor(this.fabId, commandId).length > 0;
  }

  /** Converge one command with the backend: every explicit entry goes through the scheduler. */
  reconcileCommand(commandId: string): Promise<boolean> {
    return this.scheduler.schedule(commandId);
  }

  /** Authoritative reconciliation for every tracked command through the one scheduler. */
  reconcileAll(): Promise<number> {
    return this.reconcileTracked(this.workflows.keys());
  }

  /** Reconcile only the given tracked commands; terminal/evicted ids are ignored. */
  reconcileTracked(commandIds: Iterable<string>): Promise<number> {
    const unique = [...new Set(commandIds)].filter((commandId) => {
      const workflow = this.workflows.get(commandId);
      return workflow !== undefined && !isTerminalOutcome(workflow.projection?.outcome);
    });
    return this.scheduler.scheduleMany(unique);
  }

  /**
   * Recent read-only projection: live workflows first, then the store's retained
   * terminal projection of an evicted workflow so the UI row does not vanish.
   */
  getProjection(commandId: string): CommandWorkflowProjection | undefined {
    return this.workflows.get(commandId)?.projection ?? this.projectionStore.peek(commandId);
  }

  get workflowCount(): number {
    return this.workflows.size;
  }

  get terminalWorkflowCount(): number {
    return this.terminalAt.size;
  }

  get retainedProjectionCount(): number {
    return this.projectionStore.retainedCount;
  }

  get projectionAtomCount(): number {
    return this.projectionStore.size;
  }

  get pendingCount(): number {
    return this.bridge.pendingCount;
  }

  get running(): boolean {
    return this.started;
  }

  get connectionState(): CommandConnectionStatus {
    return this.connectionStatus;
  }

  get transportFailure(): CommandTransportFailure | undefined {
    return this.lastTransportFailure;
  }

  get recoveryDroppedCount(): number {
    return this.recovery.droppedCount;
  }

  get recoveryDiagnostics(): readonly CommandRecoveryEviction[] {
    return this.recovery.diagnostics;
  }

  get lastRecoveryEviction(): CommandRecoveryEviction | undefined {
    return this.lastEviction;
  }

  get reconciliationStats(): FabReconciliationSchedulerStats {
    return this.scheduler.stats;
  }

  get lastReconciliationDrop(): ReconciliationDropDiagnostic | undefined {
    return this.lastDrop;
  }

  get lastDirtySignal(): CommandStreamDirty | undefined {
    return this.lastDirty;
  }

  get lastJournalPage(): CommandJournalPage | undefined {
    return this.lastJournalPageValue;
  }

  get lastRecoveryList(): CommandRecoveryList | undefined {
    return this.lastRecoveryListValue;
  }

  get lifecycleCounts(): FabRuntimeLifecycleCounts {
    return { created: this.createdWorkflows, finalized: this.finalizedWorkflows };
  }

  /**
   * Fixed teardown order (ADR-007 §2): scheduler -> transport -> command scopes ->
   * projections -> FabScope. Idempotent; Scope finalizers guarantee exactly-once.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    this.scheduler.dispose();
    this.runtime.runSync(Scope.close(this.transportScope, Exit.void));
    for (const [commandId, commandScope] of [...this.commandScopes]) {
      this.commandScopes.delete(commandId);
      this.runtime.runSync(Scope.close(commandScope, Exit.void));
    }
    this.workflows.clear();
    this.terminalAt.clear();
    for (const unsubscribe of this.projectionSubscriptions.values()) unsubscribe();
    this.projectionSubscriptions.clear();
    this.clearSweepTimer();
    this.recoveryRequest = undefined;
    this.passPending = false;
    this.bridge.dispose();
    this.correlation.clear();
    this.projectionStore.invalidateAll();
    // Child scopes are closed; closing FabScope also cascades anything left and
    // is idempotent, so a Runtime-level AppScope close can never double-finalize.
    this.runtime.runSync(Scope.close(this.fabScope, Exit.void));
  }

  private subscribeSignals(): void {
    const subscribe = <A>(stream: import('effect').Stream.Stream<A>, handler: (value: A) => void): void => {
      this.signalFibers.push(runCommandStream(this.runtime, this.transportScope, stream, handler));
    };
    if (this.source.gaps) {
      subscribe(this.source.gaps, (gap) => {
        this.gapObserved = true;
        this.requestRecovery({ journal: { epoch: gap.epoch, sequence: gap.sequence }, list: false });
      });
    }
    if (this.source.reconnected) {
      subscribe(this.source.reconnected, () => {
        this.requestRecovery({ list: true });
      });
    }
    if (this.source.transportFailures) {
      subscribe(this.source.transportFailures, (failure) => {
        this.lastTransportFailure = failure;
        this.requestRecovery({ list: true });
      });
    }
    if (this.source.connectionStatus) {
      subscribe(this.source.connectionStatus, (status) => {
        this.connectionStatus = status;
      });
    }
    if (this.source.dirty) {
      subscribe(this.source.dirty, (dirty) => this.onDirty(dirty));
    }
  }

  private onDirty(dirty: CommandStreamDirty): void {
    this.lastDirty = dirty;
    this.gapObserved = true;
    const cursor: JournalCursor = {
      ...(dirty.epoch !== undefined ? { epoch: dirty.epoch } : {}),
      ...(dirty.sequence !== undefined ? { sequence: dirty.sequence } : {}),
    };
    this.requestRecovery(
      dirty.epoch !== undefined || dirty.sequence !== undefined ? { journal: cursor, list: false } : { list: true },
    );
  }

  private resolveReconciliationTarget(commandId: string): { workflow: CommandWorkflow; isCurrent: () => boolean } | undefined {
    const workflow = this.workflows.get(commandId);
    if (!workflow) return undefined;
    if (isTerminalOutcome(workflow.projection?.outcome)) return undefined;
    return {
      workflow,
      isCurrent: () => !this.disposed && this.workflows.get(commandId) === workflow,
    };
  }

  private isTerminalCommand(commandId: string): boolean {
    return isTerminalOutcome(this.workflows.get(commandId)?.projection?.outcome);
  }

  /**
   * Coalesced recovery pass: one journal/list recovery followed by one scheduler
   * batch over the tracked commands. Gap/reconnect/overflow bursts share it.
   */
  private requestRecovery(request: { journal?: JournalCursor; list?: boolean }): void {
    if (this.disposed || !this.started) return;
    const previous = this.recoveryRequest;
    this.recoveryRequest = {
      journal: request.journal ?? previous?.journal,
      list: request.list === true || previous?.list === true,
    };
    if (this.passRunning) {
      this.passPending = true;
      return;
    }
    if (this.passScheduled) return;
    this.passScheduled = true;
    queueMicrotask(() => {
      this.passScheduled = false;
      void this.runRecoveryPass();
    });
  }

  private async runRecoveryPass(): Promise<void> {
    if (this.disposed) return;
    this.passRunning = true;
    try {
      const request = this.recoveryRequest;
      this.recoveryRequest = undefined;
      if (request?.journal && this.gateway) await this.recoverFromJournal(request.journal);
      if (request?.list && this.gateway) await this.recoverFromAuthoritativeList();
      if (this.recoveryRequest !== undefined) this.passPending = true;
      await this.scheduler.scheduleMany(this.workflows.keys());
    } catch {
      // Recovery is best-effort at this boundary; the next gap/reconnect retries.
    } finally {
      this.passRunning = false;
      this.gapObserved = false;
      if (this.passPending || this.recoveryRequest !== undefined) {
        this.passPending = false;
        this.requestRecovery({});
      }
    }
  }

  /** Page the journal from a broken cursor; hasGap falls back to list recovery. */
  private async recoverFromJournal(cursor: JournalCursor): Promise<void> {
    if (!this.gateway || this.disposed) return;
    try {
      const page = await this.gateway.getCommandJournalPage(this.siteId, this.fabId, {
        ...(cursor.epoch !== undefined ? { epoch: cursor.epoch } : {}),
        ...(cursor.sequence !== undefined ? { afterSequence: cursor.sequence } : {}),
        limit: 256,
      });
      if (this.disposed) return;
      this.lastJournalPageValue = page;
      if (page.hasGap) {
        await this.recoverFromAuthoritativeList();
        return;
      }
      for (const event of page.events) {
        if (event.fabId !== this.fabId) continue;
        this.bridge.receive(toResultEvent(event));
      }
    } catch {
      // Keep the dirty/gap signal authoritative: the next pass or reconnect retries.
    }
  }

  /** Authoritative list recovery after refresh/严重 gap/transport recovery (ADR-008 §2.4). */
  private async recoverFromAuthoritativeList(): Promise<void> {
    if (!this.gateway || this.disposed) return;
    try {
      const list = await this.gateway.listFabCommands(this.siteId, this.fabId, 'active');
      if (this.disposed) return;
      this.lastRecoveryListValue = list;
      for (const record of list.commands) {
        if (this.disposed) return;
        if (record.fabId !== this.fabId) continue;
        if (record.terminal) continue;
        // Unconfirmed commands from a previous page lifetime are tracked and then
        // reconciled; the local stream may hold no evidence for them.
        if (!this.workflows.has(record.commandId)) this.trackCommand(record.commandId);
        this.bridge.receive({
          fabId: record.fabId,
          commandId: record.commandId,
          revision: record.revision,
          outcome: record.outcome,
          occurredAt: record.occurredAt,
        });
      }
    } catch {
      // Best-effort: a broken recovery endpoint must not take the runtime down.
    }
  }

  private afterDelivery(commandId: string): void {
    this.publishProjection(commandId);
    this.recordTerminal(commandId);
  }

  /** Subscribe to actor snapshots before start; unsubscribe is owned with the workflow. */
  private subscribeProjection(commandId: string, workflow: CommandWorkflow): void {
    const subscribable = workflow as CommandWorkflow & { subscribe?: (listener: () => void) => () => void };
    if (typeof subscribable.subscribe !== 'function') return;
    const unsubscribe = subscribable.subscribe(() => this.publishProjection(commandId));
    this.projectionSubscriptions.set(commandId, unsubscribe);
  }

  /** XState adapters start explicitly after the projection subscription exists. */
  private startWorkflow(workflow: CommandWorkflow): void {
    const startable = workflow as CommandWorkflow & { start?: () => void };
    if (typeof startable.start === 'function') startable.start();
  }

  /** The only writer of the read-only projection store for one command. */
  private publishProjection(commandId: string): void {
    const projection = this.getProjection(commandId);
    if (projection) this.projectionStore.set(commandId, projection);
  }

  /** Track terminal state for one delivered command (O(1): no workflow scan). */
  private recordTerminal(commandId: string): void {
    if (this.disposed) return;
    const workflow = this.workflows.get(commandId);
    if (!workflow) return;
    const now = this.retention.now();
    if (isTerminalOutcome(workflow.projection?.outcome)) {
      if (!this.terminalAt.has(commandId)) this.terminalAt.set(commandId, now);
    } else if (this.terminalAt.has(commandId)) {
      this.terminalAt.delete(commandId);
    }
    this.enforceTerminalLimit();
    this.scheduleSweep();
  }

  private enforceTerminalLimit(): void {
    if (this.terminalAt.size <= this.retention.maxTerminalWorkflows) return;
    const ordered = [...this.terminalAt.entries()].sort((left, right) => left[1] - right[1]);
    const excess = this.terminalAt.size - this.retention.maxTerminalWorkflows;
    for (let index = 0; index < excess && index < ordered.length; index += 1) this.evictWorkflow(ordered[index][0]);
  }

  private scheduleSweep(): void {
    if (this.disposed || this.terminalAt.size === 0) {
      this.clearSweepTimer();
      return;
    }
    if (this.sweepTimer !== undefined) return;
    const now = this.retention.now();
    const nextExpiry = Math.min(...[...this.terminalAt.values()].map((at) => at + this.retention.terminalTtlMs));
    const delay = Math.max(1, Math.min(this.retention.sweepIntervalMs, nextExpiry - now));
    this.sweepTimer = setTimeout(() => {
      this.sweepTimer = undefined;
      this.sweep();
    }, delay);
  }

  private sweep(): void {
    if (this.disposed || !this.started) return;
    const now = this.retention.now();
    if (this.retention.terminalTtlMs > 0) {
      for (const [commandId, terminalAt] of [...this.terminalAt]) {
        if (now - terminalAt >= this.retention.terminalTtlMs) this.evictWorkflow(commandId);
      }
    }
    this.enforceTerminalLimit();
    this.correlation.sweep();
    this.scheduleSweep();
  }

  /**
   * Terminal eviction: close the command's own Scope (finalizer exactly once),
   * keep only the bounded read-only projection and never the actor.
   */
  private evictWorkflow(commandId: string): void {
    const workflow = this.workflows.get(commandId);
    this.terminalAt.delete(commandId);
    if (!workflow) return;
    const projection = workflow.projection;
    const unsubscribe = this.projectionSubscriptions.get(commandId);
    this.projectionSubscriptions.delete(commandId);
    unsubscribe?.();
    const commandScope = this.commandScopes.get(commandId);
    this.commandScopes.delete(commandId);
    this.workflows.delete(commandId);
    if (commandScope) this.runtime.runSync(Scope.close(commandScope, Exit.void));
    if (projection) this.projectionStore.retain(commandId, projection);
    else this.projectionStore.forget(commandId);
  }

  private clearSweepTimer(): void {
    if (this.sweepTimer === undefined) return;
    clearTimeout(this.sweepTimer);
    this.sweepTimer = undefined;
  }
}

function toResultEvent(event: CommandJournalEvent): CommandResultEvent {
  return {
    fabId: event.fabId,
    commandId: event.commandId,
    revision: event.revision,
    outcome: event.outcome,
    occurredAt: event.occurredAt,
  };
}
