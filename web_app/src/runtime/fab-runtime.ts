import { Effect, Exit, Scope } from 'effect';
import type * as Fiber from 'effect/Fiber';
import type * as AtomRegistry from 'effect/reactivity/AtomRegistry';
import type {
  CommandConnectionStatus,
  CommandCursor,
  CommandEventSource,
  CommandResultEvent,
  CommandStreamDirty,
  CommandStreamDirtyReason,
  CommandTransportFailure,
} from '@/contracts/command-events.contract';
import type {
  CommandGateway,
  CommandGatewayError,
  CommandJournalEvent,
  CommandJournalPage,
  CommandRecoveryFilter,
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
  type FabReconciliationSchedulerStats,
  type PhysicalRequestBudget,
  type ReconciliationDropDiagnostic,
  FabReconciliationScheduler,
  createPhysicalRequestBudget,
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

/** ADR-010 §4 recovery state machine phases (never collapsed into a boolean). */
export type CommandRecoveryPhase = 'Healthy' | 'Dirty' | 'Recovering' | 'WaitingRetry' | 'Unrecoverable';

export type CommandRecoveryDirtyCause =
  | CommandStreamDirtyReason
  | 'replay-gap'
  | 'reconnect'
  | 'transport-failure'
  | 'queue-capacity'
  | 'recovery-eviction'
  | 'refresh';

export interface CommandRecoveryDiagnostic {
  readonly at: number;
  readonly phase: CommandRecoveryPhase;
  readonly cause: CommandRecoveryDirtyCause | 'recovered' | 'error';
  readonly message?: string;
}

/** ADR-010 §4: bounded exponential backoff (500ms..15s, at most 8 attempts). */
export const DEFAULT_RECOVERY_BACKOFF_MS: readonly number[] = [500, 1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000];
export const DEFAULT_RECOVERY_MAX_ATTEMPTS = 8;
/** Backend journal page bound is 1..1000; 256 keeps a 1000-event recovery to 4 pages. */
export const DEFAULT_RECOVERY_JOURNAL_PAGE_LIMIT = 256;
const DEFAULT_MAX_JOURNAL_PAGES = 10_000;
const MAX_RECOVERY_DIAGNOSTICS = 32;

export interface FabRuntimeRecoveryOptions {
  /** Backoff schedule indexed by failed attempt (last value repeats). */
  readonly backoffMs?: readonly number[];
  /** Total attempts before Unrecoverable (default 8). */
  readonly maxAttempts?: number;
  /** Journal page limit sent to the gateway (backend clamps 1..1000). */
  readonly journalPageLimit?: number;
  /** Safety bound for the multi-page journal loop. */
  readonly maxJournalPages?: number;
  /** Authoritative list filter used for refresh/gap/queue-capacity recovery (default active). */
  readonly listFilter?: CommandRecoveryFilter;
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
  /** Native-Effect authoritative gateway (ADR-011 §2.1); executed via runtime.runPromise only. */
  readonly gateway?: CommandGateway;
  /** Test seam; production defaults to XStateCommandWorkflowAdapter. */
  readonly createWorkflow?: CommandWorkflowFactory;
  /** Test seam for retention bounds/clock; production keeps the defaults. */
  readonly retention?: FabRuntimeRetentionOptions;
  /** ADR-010 §4 recovery state machine bounds/backoff (test seam; production defaults). */
  readonly recovery?: FabRuntimeRecoveryOptions;
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

interface ResolvedRecovery {
  readonly backoffMs: readonly number[];
  readonly maxAttempts: number;
  readonly journalPageLimit: number;
  readonly maxJournalPages: number;
  readonly listFilter: CommandRecoveryFilter;
}

function resolveRecovery(options: FabRuntimeRecoveryOptions | undefined): ResolvedRecovery {
  const fallback = DEFAULT_RECOVERY_BACKOFF_MS;
  const configured = options?.backoffMs?.filter((delay) => Number.isFinite(delay) && delay >= 0);
  return {
    backoffMs: configured && configured.length > 0 ? configured : fallback,
    maxAttempts: Math.max(1, options?.maxAttempts ?? DEFAULT_RECOVERY_MAX_ATTEMPTS),
    journalPageLimit: Math.min(1000, Math.max(1, options?.journalPageLimit ?? DEFAULT_RECOVERY_JOURNAL_PAGE_LIMIT)),
    maxJournalPages: Math.max(1, options?.maxJournalPages ?? DEFAULT_MAX_JOURNAL_PAGES),
    listFilter: options?.listFilter ?? 'active',
  };
}

const TERMINAL_OUTCOMES: ReadonlySet<CommandOutcome> = new Set(['succeeded', 'failed', 'cancelled']);
const isTerminalOutcome = (outcome: CommandOutcome | 'pending' | undefined): boolean =>
  outcome !== undefined && outcome !== 'pending' && TERMINAL_OUTCOMES.has(outcome);

interface PendingRecoveryRequest {
  /** Conservative recovery start (delivered/acknowledged), never the observed cursor. */
  cursor?: CommandCursor;
  /** Authoritative LIST recovery is required (refresh/gap-without-cursor/epoch/store fault). */
  listOnly: boolean;
  cause?: CommandRecoveryDirtyCause;
}

export interface CommandRecoveryState {
  readonly phase: CommandRecoveryPhase;
  /** Attempts made in the current dirty episode (reset after recovery). */
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly lastError?: string;
  readonly lastDirtyCause?: CommandRecoveryDirtyCause;
  readonly recoveryCursor?: CommandCursor;
  readonly nextRetryAt?: number;
  readonly lastRecoveredAt?: number;
  /** Last authoritative watermark (journal latestSequence or list latestSequence). */
  readonly authoritativeWatermark?: CommandCursor;
}

export interface PhysicalRequestStats {
  readonly capacity: number;
  readonly inFlight: number;
}

export interface FabRuntimeLifecycleCounts {
  /** Workflows acquired through Effect.acquireRelease (CommandScope). */
  readonly created: number;
  /** Workflow finalizers that ran exactly once. */
  readonly finalized: number;
}

class RecoveryNeedsAuthority extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecoveryNeedsAuthority';
  }
}

class RecoveryAborted extends Error {
  constructor() {
    super('recovery aborted: runtime disposed');
    this.name = 'RecoveryAborted';
  }
}

/**
 * Per-FAB command runtime (ADR-007 §2/§3, ADR-010 §4): the only assembly point of
 * the realtime source, the CommandEventBridge, the authoritative scheduler, the
 * recovery state machine and the XState workflows.
 *
 * Scope tree owned here:
 *   FabScope
 *     ├── CommandTransportScope   (EventSource + every signal/command consumer fiber)
 *     ├── ReconciliationSchedulerScope (scheduler-owned; one scheduler per FAB)
 *     └── CommandScope(commandId) (XState actor acquired with Effect.acquireRelease)
 *
 * Recovery (ADR-010): transport gaps/dirty/reconnects enter Dirty; a coalesced
 * pass loops the epoch-scoped journal until the authoritative latestSequence,
 * validates epoch/continuity/holes and falls back to the authoritative FAB list
 * on epoch mismatch, hasGap or any invalid page. Dirty is cleared only when the
 * authoritative watermark was reached/applied; retryable failures keep Dirty and
 * retry with bounded backoff and are observable through recoveryState.
 */
export class FabRuntime {
  readonly siteId: string;
  readonly fabId: string;

  private readonly runtime: RuntimeHost;
  private readonly fabScope: Scope.Closeable;
  private readonly transportScope: Scope.Closeable;
  private readonly source: CommandEventSource;
  private readonly gateway?: CommandGateway;
  private readonly physicalBudget: PhysicalRequestBudget;
  private readonly projectionStore: CommandProjectionStore;
  private readonly scheduler: FabReconciliationScheduler;
  private readonly bridge: CommandEventBridge;
  private readonly correlation: CommandCorrelationRegistry;
  private readonly recovery: CommandEventRecovery;
  private readonly createWorkflow: CommandWorkflowFactory;
  private readonly lazyCommandSubscription: boolean;
  private readonly retention: ResolvedRetention;
  private readonly recoveryOptions: ResolvedRecovery;

  private readonly workflows = new Map<string, CommandWorkflow>();
  private readonly commandScopes = new Map<string, Scope.Closeable>();
  private readonly terminalAt = new Map<string, number>();
  private readonly projectionSubscriptions = new Map<string, () => void>();
  private readonly signalFibers: Array<Fiber.Fiber<void, never>> = [];

  private started = false;
  private disposed = false;
  private bridgeStarted = false;
  private sweepTimer?: ReturnType<typeof setTimeout>;

  private recoveryScheduled = false;
  private passRunning = false;
  /** True while the post-recovery unified scheduler batch runs (drops are covered by it). */
  private recoveryBatchRunning = false;
  private recoveryPending = false;
  private pendingRecovery: PendingRecoveryRequest | undefined;
  private activeRecoveryRequest: PendingRecoveryRequest | undefined;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private phase: CommandRecoveryPhase = 'Healthy';
  private attempts = 0;
  private lastError?: string;
  private lastDirtyCause?: CommandRecoveryDirtyCause;
  private recoveryCursor?: CommandCursor;
  private nextRetryAt?: number;
  private lastRecoveredAt?: number;
  private authoritativeWatermark?: CommandCursor;
  private readonly recoveryDiagnosticLog: CommandRecoveryDiagnostic[] = [];

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
    this.recoveryOptions = resolveRecovery(options.recovery);

    // FabScope is the only Scope this class closes; its children are created from it.
    this.fabScope = Scope.forkUnsafe(options.parentScope);
    this.transportScope = Scope.forkUnsafe(this.fabScope);
    // ADR-011 §2.2: exactly one physical HTTP budget per FAB; reconciliation and
    // recovery (journal/list) share the same four slots.
    this.physicalBudget = createPhysicalRequestBudget(4);
    this.projectionStore = new CommandProjectionStore({
      registry: options.projectionRegistry,
      maxRetained: this.retention.maxRetainedProjections,
    });
    this.recovery = new CommandEventRecovery({
      onEvict: (eviction) => {
        this.lastEviction = eviction;
        // A dropped revision may have lost an event: keep Dirty and converge from
        // the authoritative backend (never silently clear).
        this.enterDirty({ listOnly: true, cause: 'recovery-eviction' });
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
      physicalBudget: this.physicalBudget,
      gateway: options.gateway,
      resolve: (commandId) => this.resolveReconciliationTarget(commandId),
      isTerminal: (commandId) => this.isTerminalCommand(commandId),
      maxConcurrent: options.maxConcurrentReconciliations,
      maxQueued: options.maxQueuedReconciliations,
      timeoutMs: options.reconcileTimeoutMs,
      onDrop: (diagnostic) => {
        this.lastDrop = diagnostic;
        // CR-08: the scheduler no longer hides a retry buffer; the drop is durable
        // recovery intent and the authoritative list is the only convergence path.
        // A drop observed while the authoritative recovery pass / its post-recovery
        // reconciliation batch is already running is covered by that pass; scheduling
        // another pass from it would livelock when tracked commands exceed the queue
        // capacity (bounded intent, no unbounded recovery loop).
        if (this.phase === 'Recovering' || this.recoveryBatchRunning) return;
        this.recordDiagnostic('queue-capacity', 'droppedTotal=' + diagnostic.droppedTotal);
        this.enterDirty({ listOnly: true, cause: 'queue-capacity' });
      },
      onReconciled: (commandId) => this.afterDelivery(commandId),
    });
    this.createWorkflow = options.createWorkflow ??
      ((fabId, commandId) => new XStateCommandWorkflowAdapter(fabId, commandId));
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
    // Startup/refresh recovery: the authoritative list is the only recovery entry
    // for a page that never saw the submit (ADR-008 §2.4/ADR-010 §4).
    this.enterDirty({ listOnly: true, cause: 'refresh' });
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
    this.clearRetryTimer();
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
    if (this.phase !== 'Healthy' || !this.hasLocalEvidence(commandId) || revision < 0) {
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

  /** ADR-010 §4 observable recovery state (UI/diagnostic read-only view). */
  get recoveryState(): CommandRecoveryState {
    return {
      phase: this.phase,
      attempts: this.attempts,
      maxAttempts: this.recoveryOptions.maxAttempts,
      ...(this.lastError !== undefined ? { lastError: this.lastError } : {}),
      ...(this.lastDirtyCause !== undefined ? { lastDirtyCause: this.lastDirtyCause } : {}),
      ...(this.recoveryCursor !== undefined ? { recoveryCursor: { ...this.recoveryCursor } } : {}),
      ...(this.nextRetryAt !== undefined ? { nextRetryAt: this.nextRetryAt } : {}),
      ...(this.lastRecoveredAt !== undefined ? { lastRecoveredAt: this.lastRecoveredAt } : {}),
      ...(this.authoritativeWatermark !== undefined ? { authoritativeWatermark: { ...this.authoritativeWatermark } } : {}),
    };
  }

  /** Read-only bounded recovery diagnostics (newest last). */
  get recoveryHistory(): readonly CommandRecoveryDiagnostic[] {
    return this.recoveryDiagnosticLog;
  }

  /** ADR-011 §2.2: the FAB-wide physical HTTP slots shared by recovery + reconciliation. */
  get physicalRequestStats(): PhysicalRequestStats {
    return { capacity: this.physicalBudget.capacity, inFlight: this.physicalBudget.inFlight };
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
   * Recovery retry timers are cleared here so teardown leaves no timer/fiber work.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    this.clearRetryTimer();
    this.pendingRecovery = undefined;
    this.recoveryPending = false;
    this.recoveryBatchRunning = false;
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
        const cursor = gap.epoch !== undefined && gap.sequence !== undefined
          ? { epoch: gap.epoch, sequence: gap.sequence }
          : undefined;
        this.enterDirty({
          ...(cursor !== undefined ? { cursor } : {}),
          listOnly: cursor === undefined,
          cause: 'replay-gap',
        });
      });
    }
    if (this.source.reconnected) {
      subscribe(this.source.reconnected, () => {
        // ADR-010 §2: reconnects resume from the acknowledged cursor, never from
        // the observed one; without an acknowledged cursor the list is authoritative.
        const cursor = this.acknowledgedCursor();
        this.enterDirty({ ...(cursor !== undefined ? { cursor } : {}), listOnly: cursor === undefined, cause: 'reconnect' });
      });
    }
    if (this.source.transportFailures) {
      subscribe(this.source.transportFailures, (failure) => {
        this.lastTransportFailure = failure;
        const cursor = this.acknowledgedCursor();
        this.enterDirty({ ...(cursor !== undefined ? { cursor } : {}), listOnly: cursor === undefined, cause: 'transport-failure' });
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

  private acknowledgedCursor(): CommandCursor | undefined {
    const cursors = (this.source as { cursors?: { acknowledged?: CommandCursor } }).cursors;
    return cursors?.acknowledged;
  }

  private onDirty(dirty: CommandStreamDirty): void {
    this.lastDirty = dirty;
    this.recordDiagnostic(dirty.reason, 'dropped=' + dirty.droppedCount);
    const cursor = dirty.delivered ?? this.acknowledgedCursor();
    // ADR-010 §2: a dirty signal without a known gap origin cannot use the
    // journal counter as a continuation; the authoritative list is required.
    const listOnly = dirty.gapStart === undefined || dirty.reason === 'store-fault' || cursor === undefined;
    this.enterDirty({
      ...(cursor !== undefined ? { cursor } : {}),
      listOnly,
      cause: dirty.reason,
    });
  }

  /**
   * Enter Dirty with a merged recovery request and schedule the coalesced pass.
   * A new external signal re-arms an Unrecoverable runtime (the condition is
   * still observable until authoritative recovery succeeds again).
   */
  private enterDirty(input: { cursor?: CommandCursor; listOnly: boolean; cause?: CommandRecoveryDirtyCause }): void {
    if (this.disposed) return;
    this.mergeRecoveryRequest(input);
    if (input.cause !== undefined) this.lastDirtyCause = input.cause;
    this.clearRetryTimer();
    this.nextRetryAt = undefined;
    if (this.phase === 'Unrecoverable') this.attempts = 0;
    if (this.phase !== 'Recovering') this.setPhase('Dirty');
    if (!this.started) return;
    this.scheduleRecoveryPass();
  }

  private mergeRecoveryRequest(input: { cursor?: CommandCursor; listOnly: boolean; cause?: CommandRecoveryDirtyCause }): void {
    const previous = this.pendingRecovery;
    if (!previous) {
      this.pendingRecovery = {
        ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
        listOnly: input.listOnly,
        ...(input.cause !== undefined ? { cause: input.cause } : {}),
      };
      return;
    }
    let listOnly = previous.listOnly || input.listOnly;
    let cursor = previous.cursor;
    if (input.cursor !== undefined) {
      if (cursor === undefined) {
        cursor = input.cursor;
      } else if (cursor.epoch === input.cursor.epoch) {
        // Replaying from the earlier delivered position is always safe (dedupe).
        cursor = { epoch: cursor.epoch, sequence: Math.min(cursor.sequence, input.cursor.sequence) };
      } else {
        // Cursors from different epochs are not comparable: authoritative list.
        listOnly = true;
      }
    }
    this.pendingRecovery = {
      ...(cursor !== undefined ? { cursor } : {}),
      listOnly,
      ...(input.cause !== undefined ? { cause: input.cause } : previous.cause !== undefined ? { cause: previous.cause } : {}),
    };
  }

  private takeRecoveryRequest(): PendingRecoveryRequest {
    const pending = this.pendingRecovery;
    this.pendingRecovery = undefined;
    const active = this.activeRecoveryRequest;
    if (!pending) return active ?? { listOnly: true, cause: this.lastDirtyCause ?? 'refresh' };
    if (!active) {
      this.activeRecoveryRequest = pending;
      return pending;
    }
    let listOnly = active.listOnly || pending.listOnly;
    let cursor = active.cursor;
    if (pending.cursor !== undefined) {
      if (cursor === undefined) cursor = pending.cursor;
      else if (cursor.epoch === pending.cursor.epoch) cursor = { epoch: cursor.epoch, sequence: Math.min(cursor.sequence, pending.cursor.sequence) };
      else listOnly = true;
    }
    const merged: PendingRecoveryRequest = {
      ...(cursor !== undefined ? { cursor } : {}),
      listOnly,
      ...(pending.cause !== undefined ? { cause: pending.cause } : active.cause !== undefined ? { cause: active.cause } : {}),
    };
    this.activeRecoveryRequest = merged;
    return merged;
  }

  private scheduleRecoveryPass(): void {
    if (this.recoveryScheduled || this.disposed) return;
    this.recoveryScheduled = true;
    queueMicrotask(() => {
      this.recoveryScheduled = false;
      void this.runRecoveryPass();
    });
  }

  private setPhase(phase: CommandRecoveryPhase): void {
    this.phase = phase;
  }

  private recordDiagnostic(cause: CommandRecoveryDiagnostic['cause'], message?: string): void {
    this.recoveryDiagnosticLog.push({
      at: this.retention.now(),
      phase: this.phase,
      cause,
      ...(message !== undefined ? { message } : {}),
    });
    while (this.recoveryDiagnosticLog.length > MAX_RECOVERY_DIAGNOSTICS) this.recoveryDiagnosticLog.shift();
  }

  /**
   * One coalesced recovery pass (ADR-010 §4). Dirty is cleared only on success of
   * an authoritative watermark/list snapshot; retryable failures keep Dirty and
   * schedule a bounded backoff retry.
   */
  private async runRecoveryPass(): Promise<void> {
    if (this.disposed || !this.started) return;
    if (this.passRunning) {
      this.recoveryPending = true;
      return;
    }
    this.passRunning = true;
    this.clearRetryTimer();
    this.nextRetryAt = undefined;
    this.setPhase('Recovering');
    this.attempts += 1;
    const request = this.takeRecoveryRequest();
    this.recoveryCursor = request.cursor;
    try {
      const watermark = await this.executeRecovery(request);
      if (this.disposed) return;
      this.authoritativeWatermark = watermark;
      this.lastRecoveredAt = this.retention.now();
      this.attempts = 0;
      this.lastError = undefined;
      this.activeRecoveryRequest = undefined;
      this.setPhase('Healthy');
      this.recordDiagnostic('recovered', watermark !== undefined ? watermark.epoch + ':' + watermark.sequence : 'no-authority');
      // ADR-010 §4: after recovering events, run one unified reconciliation pass so
      // the tracked actors converge (fire-and-forget through the single scheduler).
      // Drops during this bounded batch are already accounted for by the recovery.
      this.recoveryBatchRunning = true;
      void this.scheduler
        .scheduleMany(this.activeCommandIds())
        .finally(() => {
          this.recoveryBatchRunning = false;
        });
    } catch (cause) {
      if (this.disposed) return;
      this.handleRecoveryFailure(cause, request);
    } finally {
      this.passRunning = false;
      if (this.recoveryPending || this.pendingRecovery !== undefined) {
        this.recoveryPending = false;
        if (!this.disposed && this.started) {
          this.clearRetryTimer();
          this.nextRetryAt = undefined;
          if (this.phase !== 'Unrecoverable') this.setPhase('Dirty');
          this.scheduleRecoveryPass();
        }
      }
    }
  }

  private async executeRecovery(request: PendingRecoveryRequest): Promise<CommandCursor | undefined> {
    const gateway = this.gateway;
    if (!gateway) return undefined;
    const start = request.cursor ?? this.acknowledgedCursor();
    if (request.listOnly || start === undefined) {
      const list = await this.runListRecovery(gateway);
      return { epoch: list.epoch, sequence: list.latestSequence };
    }
    try {
      return await this.runJournalRecovery(gateway, start);
    } catch (cause) {
      if (!(cause instanceof RecoveryNeedsAuthority)) throw cause;
      this.recordDiagnostic('replay-gap', cause.message);
      const list = await this.runListRecovery(gateway);
      return { epoch: list.epoch, sequence: list.latestSequence };
    }
  }

  private async runGateway<A>(effect: Effect.Effect<A, CommandGatewayError>): Promise<A> {
    // ADR-011: the composition-root runner executes the top-level Effect; the
    // shared physical budget wraps every recovery HTTP request (4 slots per FAB).
    return this.runtime.runPromise(this.physicalBudget.withPermit(effect));
  }

  /**
   * Loop epoch-scoped journal pages until the authoritative latestSequence.
   * Every page is validated: same epoch, strictly increasing sequences, no holes,
   * forward progress. Any violation falls back to the authoritative FAB list.
   */
  private async runJournalRecovery(gateway: CommandGateway, start: CommandCursor): Promise<CommandCursor> {
    const epoch = start.epoch;
    let cursor: CommandCursor = { ...start };
    let pages = 0;
    for (;;) {
      pages += 1;
      if (pages > this.recoveryOptions.maxJournalPages) {
        throw new RecoveryNeedsAuthority('journal recovery exceeded the page budget');
      }
      let page: CommandJournalPage;
      try {
        page = await this.runGateway(
          gateway.getCommandJournalPage(this.siteId, this.fabId, {
            epoch,
            afterSequence: cursor.sequence,
            limit: this.recoveryOptions.journalPageLimit,
          }),
        );
      } catch (cause) {
        if (isCommandGatewayError(cause) && cause._tag === 'CommandJournalEpochMismatch') {
          throw new RecoveryNeedsAuthority('journal epoch mismatch: ' + cause.message);
        }
        throw cause;
      }
      if (this.disposed) throw new RecoveryAborted();
      this.lastJournalPageValue = page;
      if (page.epoch !== epoch) {
        throw new RecoveryNeedsAuthority('journal epoch changed between pages: ' + page.epoch + ' != ' + epoch);
      }
      if (page.hasGap) throw new RecoveryNeedsAuthority('journal page reported hasGap');

      let expected = cursor.sequence;
      for (const event of page.events) {
        if (event.sequence <= expected) {
          throw new RecoveryNeedsAuthority('journal page replayed a non-increasing sequence ' + event.sequence);
        }
        if (event.sequence !== expected + 1) {
          throw new RecoveryNeedsAuthority('journal sequence hole: expected ' + (expected + 1) + ' got ' + event.sequence);
        }
        expected = event.sequence;
        if (event.fabId === this.fabId) this.bridge.receive(toResultEvent(event));
      }
      const next = typeof page.nextAfterSequence === 'number'
        ? page.nextAfterSequence
        : page.events.length > 0
          ? page.events[page.events.length - 1].sequence
          : cursor.sequence;
      if (next < cursor.sequence) throw new RecoveryNeedsAuthority('journal page moved the cursor backwards');
      cursor = { epoch, sequence: next };
      if (next >= page.latestSequence) return cursor;
      if (page.events.length === 0) {
        throw new RecoveryNeedsAuthority('journal page made no progress before the authoritative watermark');
      }
    }
  }

  /** Authoritative FAB listing: refresh/gap/epoch-mismatch/queue-capacity recovery. */
  private async runListRecovery(gateway: CommandGateway): Promise<CommandRecoveryList> {
    const list = await this.runGateway(
      gateway.listFabCommands(this.siteId, this.fabId, this.recoveryOptions.listFilter),
    );
    if (this.disposed) throw new RecoveryAborted();
    this.lastRecoveryListValue = list;
    for (const record of list.commands) {
      if (this.disposed) throw new RecoveryAborted();
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
    return list;
  }

  private handleRecoveryFailure(cause: unknown, request: PendingRecoveryRequest): void {
    const classified = classifyRecoveryError(cause);
    this.lastError = classified.message;
    this.recordDiagnostic('error', classified.message);
    this.activeRecoveryRequest = request;
    if (!this.started) {
      this.setPhase('Dirty');
      return;
    }
    if (classified.epochMismatch) {
      this.activeRecoveryRequest = { ...request, listOnly: true };
    }
    if (classified.unrecoverable || this.attempts >= this.recoveryOptions.maxAttempts) {
      this.activeRecoveryRequest = undefined;
      this.setPhase('Unrecoverable');
      return;
    }
    const delay = this.recoveryOptions.backoffMs[
      Math.min(this.attempts - 1, this.recoveryOptions.backoffMs.length - 1)
    ];
    this.nextRetryAt = this.retention.now() + delay;
    this.setPhase('WaitingRetry');
    this.clearRetryTimer();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.nextRetryAt = undefined;
      if (this.disposed || !this.started) return;
      this.scheduleRecoveryPass();
    }, delay);
  }

  private clearRetryTimer(): void {
    if (this.retryTimer === undefined) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private activeCommandIds(): string[] {
    return [...this.workflows.keys()].filter((commandId) => !this.isTerminalCommand(commandId));
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

interface ClassifiedRecoveryError {
  readonly message: string;
  readonly unrecoverable: boolean;
  readonly epochMismatch: boolean;
}

function isCommandGatewayError(cause: unknown): cause is CommandGatewayError {
  return typeof cause === 'object' && cause !== null && '_tag' in cause;
}

function classifyRecoveryError(cause: unknown): ClassifiedRecoveryError {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (cause instanceof RecoveryAborted) return { message, unrecoverable: true, epochMismatch: false };
  if (!isCommandGatewayError(cause)) return { message, unrecoverable: false, epochMismatch: false };
  switch (cause._tag) {
    case 'CommandRequestAborted':
      return { message: cause.message, unrecoverable: true, epochMismatch: false };
    case 'CommandJournalEpochMismatch':
      return { message: cause.message, unrecoverable: false, epochMismatch: true };
    case 'CommandGatewayRetryableFailure':
      return { message: cause.message, unrecoverable: false, epochMismatch: false };
    case 'CommandGatewayTerminalFailure':
      return { message: cause.message, unrecoverable: true, epochMismatch: false };
    default:
      return { message, unrecoverable: false, epochMismatch: false };
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
