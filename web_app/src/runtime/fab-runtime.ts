import { Duration, Effect, Exit, Fiber, Option, Scope } from 'effect';
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
  DEFAULT_MAX_QUEUED_RECONCILIATIONS,
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

/**
 * ADR-010 §4 recovery state machine phases (never collapsed into a boolean).
 * `Unavailable` is the R3-07 display-only state: a runtime assembled without an
 * authoritative gateway can never be Healthy and never claims recovery.
 */
export type CommandRecoveryPhase =
  | 'Healthy'
  | 'Dirty'
  | 'Recovering'
  | 'WaitingRetry'
  | 'Unrecoverable'
  | 'Unavailable';

/** R3-07: explicit command-recovery authority of one FabRuntime. */
export type CommandRecoveryAvailability = 'available' | 'unavailable';

export type CommandRecoveryDirtyCause =
  | CommandStreamDirtyReason
  | 'replay-gap'
  | 'reconnect'
  | 'transport-failure'
  | 'queue-capacity'
  | 'recovery-eviction'
  | 'refresh'
  | 'no-authority'
  | 'protocol-error';

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
/** R3-05: every journal/list recovery request is an owned Effect bounded by this deadline. */
export const DEFAULT_RECOVERY_REQUEST_TIMEOUT_MS = 10_000;
/** R3-08: bounded post-snapshot compensation passes before a drop episode is Unrecoverable. */
export const DEFAULT_MAX_COMPENSATION_PASSES = 4;
/** R3-08: pending drop intents are bounded; the next authoritative snapshot converges the rest. */
const MAX_PENDING_RECOVERY_DROPS = 256;

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
  /**
   * R3-05: per-request deadline for journal/list recovery (default 10s). The
   * timeout interrupts the owned recovery fiber, which aborts the fetch signal and
   * only then releases the shared physical permit.
   */
  readonly requestTimeoutMs?: number;
  /**
   * R3-08: bounded compensation passes after a drop observed after the
   * authoritative snapshot was taken. 0 = the first post-snapshot drop is
   * immediately Unrecoverable.
   */
  readonly maxCompensationPasses?: number;
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
  /**
   * R3-07: REQUIRED explicit command-recovery authority. A composition root must
   * state whether authoritative recovery exists: pass the native-Effect
   * CommandGateway (ADR-011 §2.1), or `undefined` to declare an explicitly
   * display-only runtime (Storybook/jsdom only). A display-only runtime never
   * schedules recovery, never creates a recovery timer and stays in the observable
   * `Unavailable` phase with a no-authority diagnostic; it can never become Healthy.
   * There is no implicit "no gateway => recovered" path.
   */
  readonly gateway: CommandGateway | undefined;
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
  readonly requestTimeoutMs: number;
  readonly maxCompensationPasses: number;
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
    requestTimeoutMs: Math.max(1, options?.requestTimeoutMs ?? DEFAULT_RECOVERY_REQUEST_TIMEOUT_MS),
    maxCompensationPasses: Math.max(0, options?.maxCompensationPasses ?? DEFAULT_MAX_COMPENSATION_PASSES),
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

/** R3-08: durable intent of one scheduler queue-capacity drop (bounded, never a hidden retry queue). */
interface RecoveryDropIntent {
  /** Monotonic drop generation; a pass snapshot covers every drop generation <= its dropBarrier. */
  readonly generation: number;
  readonly commandId: string;
  readonly droppedTotal: number;
}

/** R3-05/R3-08: one authoritative snapshot produced by one recovery pass generation. */
interface RecoverySnapshot {
  readonly generation: number;
  readonly kind: 'journal' | 'list';
  readonly epoch: string;
  /** Authoritative watermark (journal next cursor / list latestSequence). */
  readonly sequence: number;
  /** Highest drop generation that existed when this pass started; covered by this snapshot. */
  readonly dropBarrier: number;
  readonly pages: number;
  readonly appliedRecords: number;
  readonly startedAt: number;
  readonly finishedAt: number;
}

/** R3-08 observable evidence of the last authoritative snapshot (covered vs pending drops). */
export interface CommandRecoverySnapshotState {
  readonly generation: number;
  readonly kind: 'journal' | 'list';
  readonly epoch: string;
  readonly sequence: number;
  readonly pages: number;
  readonly appliedRecords: number;
  readonly dropBarrier: number;
  readonly coveredDrops: number;
  readonly needsNextAuthoritativePass: boolean;
  readonly startedAt: number;
  readonly finishedAt: number;
}

export interface CommandRecoveryState {
  readonly phase: CommandRecoveryPhase;
  /** R3-07: explicit authority; `unavailable` runtimes never report Healthy. */
  readonly availability: CommandRecoveryAvailability;
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
  /** R3-05: monotonic recovery generation; a stale generation may never write state. */
  readonly recoveryGeneration: number;
  /** R3-05: true while a recovery pass owner fiber is running. */
  readonly recovering: boolean;
  /** R3-08: a recovery pass is queued/armed for the current dirty episode. */
  readonly recoveryPending: boolean;
  /** R3-08: post-snapshot drops still require the next authoritative pass (never Healthy). */
  readonly needsNextAuthoritativePass: boolean;
  /** R3-08: total drops proven covered by an authoritative snapshot (not retried). */
  readonly coveredDropCount: number;
  /** R3-08: bounded post-snapshot compensation attempts used in this episode. */
  readonly compensationAttempts: number;
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

/** R3-05: one recovery HTTP request exceeded its Effect.timeout deadline. */
class RecoveryTimeout extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecoveryTimeout';
  }
}

/** R3-01/R3-03: an authoritative response violated the frozen recovery contract. */
class RecoveryProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecoveryProtocolError';
  }
}

/** One typed recovery-pass failure with its classified retry/terminal semantics. */
class RecoveryPassFailure extends Error {
  constructor(
    readonly classified: ClassifiedRecoveryError,
    readonly cause: unknown,
  ) {
    super(classified.message);
    this.name = 'RecoveryPassFailure';
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
 *     ├── RecoveryScope           (R3-05: the single owned recovery pass fiber)
 *     ├── ReconciliationSchedulerScope (scheduler-owned; one scheduler per FAB)
 *     └── CommandScope(commandId) (XState actor acquired with Effect.acquireRelease)
 *
 * Recovery (ADR-010 §6): transport gaps/dirty/reconnects enter Dirty; one
 * coalesced pass runs as a scoped Effect fiber (R3-05 RecoveryScope) and loops the
 * epoch-scoped journal until the authoritative latestSequence. FAB-filtered pages
 * are validated as sparse Site sequences (strict increase + cursor bounds +
 * nextAfterSequence progress); epoch mismatch, server hasGap and any invalid page
 * fall back to the authoritative FAB list. The phase clears to Healthy only after
 * the authoritative watermark was applied, the bounded post-recovery batch ran and
 * every recorded drop was proven covered (R3-08); retryable failures keep Dirty and
 * retry with bounded backoff. A runtime assembled without a gateway stays in the
 * observable Unavailable phase (R3-07).
 */
export class FabRuntime {
  readonly siteId: string;
  readonly fabId: string;

  private readonly runtime: RuntimeHost;
  private readonly fabScope: Scope.Closeable;
  private readonly transportScope: Scope.Closeable;
  private readonly source: CommandEventSource;
  private readonly gateway: CommandGateway | undefined;
  private readonly physicalBudget: PhysicalRequestBudget;
  /** R3-05: FabScope child that owns every recovery pass fiber (interrupted on dispose). */
  private readonly recoveryScope: Scope.Closeable;
  /** R3-07: explicit authority declaration; unavailable = display-only, never Healthy. */
  private readonly recoveryAvailable: boolean;
  private readonly maxQueuedReconciliations: number;
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
  /** True while the post-recovery unified scheduler batch runs (drops are classified against it). */
  private recoveryBatchRunning = false;
  private recoveryPending = false;
  private pendingRecovery: PendingRecoveryRequest | undefined;
  private activeRecoveryRequest: PendingRecoveryRequest | undefined;
  private retryTimer?: ReturnType<typeof setTimeout>;

  /** R3-05: owner generation + fiber handle of the one in-flight recovery pass. */
  private recoveryGeneration = 0;
  private recoveryFiber: Fiber.Fiber<void, never> | undefined;
  /** R3-08: monotonic drop generation; snapshot barriers prove which drops were covered. */
  private dropGeneration = 0;
  private pendingDrops: RecoveryDropIntent[] = [];
  private coveredDropCount = 0;
  private coveredDropsThisPass = 0;
  private compensationAttempts = 0;
  private compensationNoProgressRounds = 0;
  private compensationBaseline: { readonly coveredDrops: number; readonly sequence: number | undefined } | undefined;
  private needsNextAuthoritativePass = false;
  /** R3-08: suppress per-record reconcile scheduling while an authoritative snapshot is applied. */
  private suppressSnapshotScheduling = false;
  private lastSnapshotState?: CommandRecoverySnapshotState;
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
    this.recoveryAvailable = options.gateway !== undefined;
    this.lazyCommandSubscription = options.lazyCommandSubscription === true;
    this.retention = resolveRetention(options.retention);
    this.recoveryOptions = resolveRecovery(options.recovery);
    this.maxQueuedReconciliations = Math.max(1, options.maxQueuedReconciliations ?? DEFAULT_MAX_QUEUED_RECONCILIATIONS);

    // FabScope is the only Scope this class closes; its children are created from it.
    this.fabScope = Scope.forkUnsafe(options.parentScope);
    this.transportScope = Scope.forkUnsafe(this.fabScope);
    // R3-05: the RecoveryScope is a FabScope child; every recovery pass fiber (and
    // its journal/list request) is owned by it and interrupted on dispose.
    this.recoveryScope = Scope.forkUnsafe(this.fabScope);
    if (!this.recoveryAvailable) {
      // R3-07: no authoritative gateway is an explicit display-only composition,
      // never an implicit "already recovered" state.
      this.phase = 'Unavailable';
      this.recordDiagnostic('no-authority', 'authoritative command gateway is not configured: display-only runtime (recovery unavailable)');
    }
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
        // CR-08/R3-08: the scheduler keeps no hidden retry buffer. Every drop is a
        // generation-stamped recovery intent; the next authoritative snapshot
        // decides whether it was covered (no retry) or still needs a pass (never a
        // silent Healthy).
        this.recordDropIntent(diagnostic);
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
    if (!this.recoveryAvailable) {
      // R3-07: display-only composition. Transport signals still deliver live
      // events to actors, but no recovery request/timer exists and the phase is
      // permanently Unavailable (never Healthy, never Unrecoverable).
      this.setPhase('Unavailable');
      this.recordDiagnostic('no-authority', 'start(): command recovery unavailable; live events only, phase stays Unavailable');
      this.scheduleSweep();
      return;
    }
    // Startup/refresh recovery: the authoritative list is the only recovery entry
    // for a page that never saw the submit (ADR-008 §2.4/ADR-010 §4).
    this.enterDirty({ listOnly: true, cause: 'refresh' });
    this.scheduleSweep();
  }

  /**
   * Pause semantics (R3-05): stop() stops the transport consumer fibers and
   * *interrupts the in-flight recovery pass fiber* (aborting its journal/list
   * fetch and releasing the shared physical permit) before returning. Pending
   * recovery intent and drop generations are retained; the next start() re-arms
   * the authoritative pass. No recovery network request or retry timer survives
   * stop(). The reconciliation scheduler stays alive so an explicit
   * reconcileCommand()/dispose() path is unaffected.
   */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.interruptRecoveryPass();
    this.clearRetryTimer();
    this.nextRetryAt = undefined;
    if (this.recoveryAvailable && this.phase !== 'Unrecoverable' && this.phase !== 'Unavailable') {
      // Paused while dirty: observable and never Healthy until a new snapshot.
      this.setPhase('Dirty');
    }
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
    // R3-08: while an authoritative snapshot is being applied, recovered commands
    // are converged by the bounded post-recovery batch, not by one reconcile per
    // tracked record (that is what used to overflow the 128-item scheduler queue).
    if (!this.suppressSnapshotScheduling && (this.phase !== 'Healthy' || !this.hasLocalEvidence(commandId) || revision < 0)) {
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
      availability: this.recoveryAvailable ? 'available' : 'unavailable',
      attempts: this.attempts,
      maxAttempts: this.recoveryOptions.maxAttempts,
      recoveryGeneration: this.recoveryGeneration,
      recovering: this.passRunning,
      recoveryPending: this.recoveryPending || this.pendingRecovery !== undefined,
      needsNextAuthoritativePass: this.needsNextAuthoritativePass,
      coveredDropCount: this.coveredDropCount,
      compensationAttempts: this.compensationAttempts,
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

  /** R3-07: explicit authority marker for UI/diagnostics. */
  get recoveryAvailability(): CommandRecoveryAvailability {
    return this.recoveryAvailable ? 'available' : 'unavailable';
  }

  /** R3-08: evidence of the last authoritative snapshot (covered drops vs pending drops). */
  get lastRecoverySnapshot(): CommandRecoverySnapshotState | undefined {
    return this.lastSnapshotState;
  }

  /** R3-08: drop intents not yet proven covered by an authoritative snapshot. */
  get pendingDropCount(): number {
    return this.pendingDrops.length;
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
   * Fixed teardown order (ADR-007 §2, R3-05): stop the transport consumers and
   * interrupt the recovery pass -> close the RecoveryScope (aborting every
   * journal/list fetch and returning its shared physical permit) -> scheduler ->
   * transport scope -> command scopes -> projections -> FabScope. Idempotent; the
   * recovery generation is invalidated before teardown so a late callback can
   * never write the projection store, change the recovery phase or schedule
   * another pass.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    // Even a never-started runtime must invalidate its generation so any queued
    // microtask/fiber sees isRecoveryCurrent() === false.
    this.recoveryGeneration += 1;
    this.clearRetryTimer();
    this.pendingRecovery = undefined;
    this.activeRecoveryRequest = undefined;
    this.pendingDrops = [];
    this.recoveryPending = false;
    this.recoveryBatchRunning = false;
    this.needsNextAuthoritativePass = false;
    // R3-05: interrupt the recovery work while the shared budget still exists;
    // Scope.close waits for the interruption finalizers (fetch abort + permit
    // release), so no recovery callback runs after dispose returns.
    this.runtime.runSync(Scope.close(this.recoveryScope, Exit.void));
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
      subscribe(this.source.gaps, () => {
        this.enterDirty({ listOnly: true, cause: 'replay-gap' });
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
    if (!this.recoveryAvailable) {
      // R3-07: a display-only runtime records the request but never claims
      // Dirty/Recovering/Healthy: there is no authoritative gateway to converge on.
      this.setPhase('Unavailable');
      this.recordDiagnostic(input.cause ?? 'no-authority', 'recovery request observed but authoritative recovery is unavailable');
      return;
    }
    // A new external dirty signal starts a fresh bounded compensation episode.
    this.compensationAttempts = 0;
    this.compensationNoProgressRounds = 0;
    this.compensationBaseline = undefined;
    this.needsNextAuthoritativePass = false;
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
    if (this.recoveryScheduled || this.disposed || !this.recoveryAvailable) return;
    this.recoveryScheduled = true;
    queueMicrotask(() => {
      this.recoveryScheduled = false;
      if (this.disposed || !this.started || !this.recoveryAvailable) return;
      this.launchRecoveryPass();
    });
  }

  /**
   * R3-05: start the one owned recovery pass. The pass is an explicit Effect
   * fiber in the RecoveryScope, never a bare `void runPromise` network task; its
   * journal/list requests are child Effects bounded by Effect.timeout, so
   * interrupting the fiber aborts fetch and releases the shared physical permit.
   */
  private launchRecoveryPass(): void {
    if (this.disposed || !this.started || !this.recoveryAvailable) return;
    if (this.passRunning) {
      this.recoveryPending = true;
      return;
    }
    const request = this.takeRecoveryRequest();
    this.passRunning = true;
    this.clearRetryTimer();
    this.nextRetryAt = undefined;
    this.setPhase('Recovering');
    this.attempts += 1;
    this.recoveryCursor = request.cursor;
    this.runRecoveryPassFiber(request);
  }

  /** Fork the pass program into the RecoveryScope (the only owner of recovery work). */
  private runRecoveryPassFiber(request: PendingRecoveryRequest): void {
    const generation = ++this.recoveryGeneration;
    const dropsAtStart = this.dropGeneration;
    this.coveredDropsThisPass = 0;
    const program = this.executeRecoveryEffect(generation, request, dropsAtStart).pipe(
      Effect.flatMap((snapshot) => this.completeRecoveryEffect(generation, snapshot)),
      Effect.catch((failure: RecoveryPassFailure) => Effect.sync(() => {
        if (this.isRecoveryCurrent(generation)) this.handleRecoveryFailure(failure, request, generation);
      })),
      Effect.catchDefect((defect) => Effect.sync(() => {
        if (this.isRecoveryCurrent(generation)) {
          this.handleRecoveryFailure(
            new RecoveryPassFailure(classifyRecoveryError(defect), defect),
            request,
            generation,
          );
        }
      })),
      Effect.ensuring(Effect.sync(() => this.finishRecoveryPass(generation))),
    );
    try {
      this.recoveryFiber = this.runtime.runSync(Effect.forkIn(program, this.recoveryScope));
    } catch (cause) {
      // The execution boundary itself refused the pass (e.g. an already-disposed
      // runner): surface it through the same bounded failure path instead of
      // leaving the state machine stuck in Recovering.
      this.finishRecoveryPass(generation);
      if (this.isRecoveryCurrent(generation)) {
        this.handleRecoveryFailure(new RecoveryPassFailure(classifyRecoveryError(cause), cause), request, generation);
      }
    }
  }

  /**
   * R3-05: interrupt the current recovery pass (stop/dispose). The generation is
   * bumped first so a late continuation can never write projectionStore/phase or
   * schedule reconciliation, then the owned fiber is interrupted (fetch abort)
   * before the call returns.
   */
  private interruptRecoveryPass(): void {
    this.recoveryGeneration += 1;
    this.passRunning = false;
    this.recoveryBatchRunning = false;
    this.recoveryPending = false;
    this.suppressSnapshotScheduling = false;
    const fiber = this.recoveryFiber;
    this.recoveryFiber = undefined;
    if (fiber !== undefined) this.runtime.runSync(Fiber.interrupt(fiber));
  }

  /** Owner-local completion; only the current generation may clear the owner or arm another pass. */
  private finishRecoveryPass(generation: number): void {
    if (generation === this.recoveryGeneration) {
      this.passRunning = false;
      this.recoveryBatchRunning = false;
      this.recoveryFiber = undefined;
    }
    if (this.disposed || !this.started || generation !== this.recoveryGeneration) return;
    if (this.recoveryPending || this.pendingRecovery !== undefined) {
      this.recoveryPending = false;
      this.clearRetryTimer();
      this.nextRetryAt = undefined;
      if (this.phase !== 'Unrecoverable' && this.phase !== 'Unavailable' && this.phase !== 'WaitingRetry') {
        this.setPhase('Dirty');
      }
      this.scheduleRecoveryPass();
    }
  }

  /** True only for the owner generation of a live, started runtime (late-result guard). */
  private isRecoveryCurrent(generation: number): boolean {
    return !this.disposed && this.started && generation === this.recoveryGeneration;
  }

  private ensureRecoveryCurrent(generation: number): Effect.Effect<void, RecoveryPassFailure> {
    const self = this;
    return Effect.suspend((): Effect.Effect<void, RecoveryPassFailure> => self.isRecoveryCurrent(generation)
      ? Effect.void
      : Effect.fail(new RecoveryPassFailure(
        { message: 'recovery generation superseded', unrecoverable: false, epochMismatch: false },
        new RecoveryAborted(),
      )));
  }

  /**
   * R3-08: record one scheduler queue-capacity drop as durable intent. Drops are
   * stamped with a monotonic generation; a snapshot with dropBarrier >= generation
   * proves the drop was covered (recorded, never retried), while a later drop
   * forces needsNextAuthoritativePass and a bounded compensation pass.
   */
  private recordDropIntent(diagnostic: ReconciliationDropDiagnostic): void {
    this.dropGeneration += 1;
    this.pendingDrops.push({
      generation: this.dropGeneration,
      commandId: diagnostic.commandId,
      droppedTotal: diagnostic.droppedTotal,
    });
    while (this.pendingDrops.length > MAX_PENDING_RECOVERY_DROPS) this.pendingDrops.shift();
    if (!this.recoveryAvailable) {
      this.recordDiagnostic('queue-capacity', 'droppedTotal=' + diagnostic.droppedTotal + ' (recovery unavailable: recorded only)');
      return;
    }
    this.recordDiagnostic(
      'queue-capacity',
      'droppedTotal=' + diagnostic.droppedTotal + ' dropGeneration=' + this.dropGeneration +
        ' phase=' + this.phase + ' recovering=' + this.passRunning,
    );
    if (this.passRunning || this.phase === 'Recovering' || this.recoveryBatchRunning) {
      // Covered-or-pending is decided against the snapshot barrier, never silently.
      return;
    }
    this.enterDirty({ listOnly: true, cause: 'queue-capacity' });
  }

  /**
   * R3-08: prove which recorded drops the authoritative snapshot covered. A drop
   * generation <= the pass's dropBarrier existed before the snapshot was taken, so
   * the authoritative state supersedes its reconciliation intent.
   */
  private resolveCoveredDrops(dropBarrier: number): number {
    if (this.pendingDrops.length === 0) return 0;
    const remaining: RecoveryDropIntent[] = [];
    let covered = 0;
    for (const drop of this.pendingDrops) {
      if (drop.generation <= dropBarrier) covered += 1;
      else remaining.push(drop);
    }
    this.pendingDrops = remaining;
    if (covered > 0) {
      this.coveredDropCount += covered;
      this.coveredDropsThisPass += covered;
      this.recordDiagnostic('queue-capacity', covered + ' drop(s) covered by authoritative recovery generation ' + this.recoveryGeneration);
    }
    return covered;
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
   * R3-05/R3-08: resolve and apply one authoritative snapshot in the owned
   * recovery fiber. Typed failures are classified by the caller; interruption
   * (stop/dispose/timeout) exits through Effect interruption and never reaches the
   * success continuation.
   */
  private executeRecoveryEffect(
    generation: number,
    request: PendingRecoveryRequest,
    dropsAtStart: number,
  ): Effect.Effect<RecoverySnapshot, RecoveryPassFailure> {
    const self = this;
    return Effect.suspend((): Effect.Effect<RecoverySnapshot, RecoveryPassFailure> => {
      const gateway = self.gateway;
      if (gateway === undefined) {
        return Effect.fail(new RecoveryPassFailure(
          { message: 'authoritative command gateway is not configured', unrecoverable: true, epochMismatch: false },
          new Error('no-authoritative-gateway'),
        ));
      }
      const start = request.cursor ?? self.acknowledgedCursor();
      if (request.listOnly || start === undefined) {
        return self.listRecoveryEffect(generation, gateway, dropsAtStart);
      }
      return self.journalRecoveryEffect(generation, gateway, start, dropsAtStart).pipe(
        Effect.catch((cause: RecoveryNeedsAuthority | RecoveryPassFailure) => {
          if (cause instanceof RecoveryNeedsAuthority) {
            self.recordDiagnostic('replay-gap', cause.message);
            return self.listRecoveryEffect(generation, gateway, dropsAtStart);
          }
          if (cause.classified.epochMismatch) {
            self.recordDiagnostic('replay-gap', cause.message);
            return self.listRecoveryEffect(generation, gateway, dropsAtStart);
          }
          return Effect.fail(cause);
        }),
      );
    });
  }

  /**
   * R3-05: one recovery HTTP request as a child Effect. The shared physical
   * budget wraps the real gateway Effect; Effect.timeout interrupts it, which
   * aborts the fetch signal and only then releases the permit (ensuring order).
   * The owner generation is checked before and after so a stale generation can
   * never apply a result.
   */
  private recoveryRequestEffect<A>(
    generation: number,
    request: Effect.Effect<A, CommandGatewayError>,
  ): Effect.Effect<A, RecoveryPassFailure> {
    const self = this;
    return Effect.gen(function* () {
      yield* self.ensureRecoveryCurrent(generation);
      const outcome = yield* self.physicalBudget.withPermit(request).pipe(
        Effect.timeoutOption(Duration.millis(self.recoveryOptions.requestTimeoutMs)),
        Effect.catch((error: CommandGatewayError) => Effect.fail(
          new RecoveryPassFailure(classifyRecoveryError(error), error),
        )),
      );
      if (Option.isSome(outcome)) {
        yield* self.ensureRecoveryCurrent(generation);
        return outcome.value;
      }
      const timeout = new RecoveryTimeout(
        'recovery request exceeded ' + self.recoveryOptions.requestTimeoutMs + 'ms',
      );
      return yield* Effect.fail(new RecoveryPassFailure(classifyRecoveryError(timeout), timeout));
    });
  }

  /**
   * R3-01/R3-07: authoritative FAB listing (refresh/gap/epoch/queue-capacity
   * recovery). The list watermark and every record identity are validated before
   * any state is applied; an inconsistent authoritative response is a protocol
   * failure, never a silent success.
   */
  private listRecoveryEffect(
    generation: number,
    gateway: CommandGateway,
    dropsAtStart: number,
  ): Effect.Effect<RecoverySnapshot, RecoveryPassFailure> {
    const self = this;
    return Effect.gen(function* () {
      yield* self.ensureRecoveryCurrent(generation);
      const list = yield* self.recoveryRequestEffect(
        generation,
        gateway.listFabCommands(self.siteId, self.fabId, self.recoveryOptions.listFilter),
      );
      yield* self.ensureRecoveryCurrent(generation);
      const protocolError = validateRecoveryList(list, self.fabId);
      if (protocolError !== undefined) {
        const error = new RecoveryProtocolError(protocolError);
        return yield* Effect.fail(new RecoveryPassFailure(classifyRecoveryError(error), error));
      }
      self.lastRecoveryListValue = list;
      const startedAt = self.retention.now();
      let appliedRecords = 0;
      self.suppressSnapshotScheduling = true;
      try {
        for (const record of list.commands) {
          yield* self.ensureRecoveryCurrent(generation);
          if (record.terminal) continue;
          if (!self.workflows.has(record.commandId)) self.trackCommand(record.commandId);
          self.bridge.receive({
            fabId: record.fabId,
            commandId: record.commandId,
            revision: record.revision,
            outcome: record.outcome,
            occurredAt: record.occurredAt,
          });
          appliedRecords += 1;
        }
      } finally {
        self.suppressSnapshotScheduling = false;
      }
      yield* self.ensureRecoveryCurrent(generation);
      const snapshot: RecoverySnapshot = {
        generation,
        kind: 'list',
        epoch: list.epoch,
        sequence: list.latestSequence,
        dropBarrier: dropsAtStart,
        pages: 1,
        appliedRecords,
        startedAt,
        finishedAt: self.retention.now(),
      };
      return snapshot;
    });
  }

  /**
   * R3-03: loop epoch-scoped journal pages until the authoritative
   * nextAfterSequence reaches latestSequence. FAB-filtered pages are sparse: the
   * only continuity rules are strict Site-sequence increase, epoch equality,
   * cursor bounds and nextAfterSequence progress; a neighbour gap is never proof
   * of a Site journal hole (server hasGap is the only gap authority). Every
   * validation failure is RecoveryNeedsAuthority -> authoritative FAB list.
   */
  private journalRecoveryEffect(
    generation: number,
    gateway: CommandGateway,
    start: CommandCursor,
    dropsAtStart: number,
  ): Effect.Effect<RecoverySnapshot, RecoveryNeedsAuthority | RecoveryPassFailure> {
    const self = this;
    return Effect.gen(function* () {
      const epoch = start.epoch;
      const startedAt = self.retention.now();
      let cursor: CommandCursor = { ...start };
      let pages = 0;
      let appliedRecords = 0;
      let previousLatestSequence = -1;
      let previousFirstRetainedSequence = -1;
      for (;;) {
        pages += 1;
        if (pages > self.recoveryOptions.maxJournalPages) {
          return yield* Effect.fail(new RecoveryNeedsAuthority('journal recovery exceeded the page budget'));
        }
        yield* self.ensureRecoveryCurrent(generation);
        const page = yield* self.recoveryRequestEffect(
          generation,
          gateway.getCommandJournalPage(self.siteId, self.fabId, {
            epoch,
            afterSequence: cursor.sequence,
            limit: self.recoveryOptions.journalPageLimit,
          }),
        );
        yield* self.ensureRecoveryCurrent(generation);
        self.lastJournalPageValue = page;
        const violation = validateJournalPage(page, {
          fabId: self.fabId,
          epoch,
          cursorSequence: cursor.sequence,
          previousLatestSequence,
          previousFirstRetainedSequence,
        });
        if (violation !== undefined) {
          return yield* Effect.fail(new RecoveryNeedsAuthority(violation));
        }
        previousLatestSequence = page.latestSequence;
        previousFirstRetainedSequence = page.firstRetainedSequence;
        for (const event of page.events) {
          self.bridge.receive(toResultEvent(event));
          appliedRecords += 1;
        }
        cursor = { epoch, sequence: page.nextAfterSequence };
        if (page.nextAfterSequence >= page.latestSequence) {
          const snapshot: RecoverySnapshot = {
            generation,
            kind: 'journal',
            epoch,
            sequence: page.nextAfterSequence,
            dropBarrier: dropsAtStart,
            pages,
            appliedRecords,
            startedAt,
            finishedAt: self.retention.now(),
          };
          return snapshot;
        }
      }
    });
  }

  /**
   * R3-08: after a verified snapshot, run the bounded post-recovery reconciliation
   * batch and only then decide Healthy. A drop observed after the snapshot makes
   * needsNextAuthoritativePass true, so the pass can never return to Healthy for it.
   */
  private completeRecoveryEffect(
    generation: number,
    snapshot: RecoverySnapshot,
  ): Effect.Effect<void, RecoveryPassFailure> {
    const self = this;
    return Effect.gen(function* () {
      yield* self.ensureRecoveryCurrent(generation);
      self.applyRecoverySnapshot(snapshot);
      const covered = self.resolveCoveredDrops(snapshot.dropBarrier);
      self.lastSnapshotState = {
        generation: snapshot.generation,
        kind: snapshot.kind,
        epoch: snapshot.epoch,
        sequence: snapshot.sequence,
        pages: snapshot.pages,
        appliedRecords: snapshot.appliedRecords,
        dropBarrier: snapshot.dropBarrier,
        coveredDrops: covered,
        needsNextAuthoritativePass: self.pendingDrops.length > 0,
        startedAt: snapshot.startedAt,
        finishedAt: snapshot.finishedAt,
      };
      self.recoveryBatchRunning = true;
      yield* self.reconcileActiveBatchEffect(generation).pipe(
        Effect.ensuring(Effect.sync(() => {
          self.recoveryBatchRunning = false;
        })),
      );
      yield* self.ensureRecoveryCurrent(generation);
      if (self.pendingDrops.length > 0) {
        self.needsNextAuthoritativePass = true;
        const previous = self.lastSnapshotState;
        if (previous !== undefined) self.lastSnapshotState = { ...previous, needsNextAuthoritativePass: true };
        self.scheduleCompensationPass(generation);
        return;
      }
      self.needsNextAuthoritativePass = false;
      self.compensationAttempts = 0;
      self.compensationNoProgressRounds = 0;
      self.compensationBaseline = undefined;
      self.activeRecoveryRequest = undefined;
      self.setPhase('Healthy');
      self.recordDiagnostic(
        'recovered',
        snapshot.epoch + ':' + snapshot.sequence + ' (' + snapshot.kind + ', dropBarrier=' + snapshot.dropBarrier + ')',
      );
    });
  }

  /**
   * Apply the authoritative watermark and sign the transport safe watermark
   * (R3-02 seam). Only the current recovery generation reaches this method, so
   * source.cover() can never be driven by a stale/old-generation snapshot.
   */
  private applyRecoverySnapshot(snapshot: RecoverySnapshot): void {
    const watermark: CommandCursor = { epoch: snapshot.epoch, sequence: snapshot.sequence };
    this.authoritativeWatermark = watermark;
    this.lastRecoveredAt = this.retention.now();
    this.attempts = 0;
    this.lastError = undefined;
    this.activeRecoveryRequest = undefined;
    // R3-02/R3-05: mark ledger entries at/before the authoritative cursor covered.
    // The transport never regresses the same-epoch acknowledged sequence.
    this.source.cover(watermark);
  }

  /**
   * R3-08: converge tracked active commands through the one scheduler in bounded
   * batches sized by the remaining scheduler queue capacity, so the recovery pass
   * itself never overflows the queue and never loops the same 128 commands.
   * Commands with pending drop intents are reconciled first (priority).
   */
  private reconcileActiveBatchEffect(generation: number): Effect.Effect<void, RecoveryPassFailure> {
    const self = this;
    return Effect.gen(function* () {
      const pending = self.prioritizedActiveCommandIds();
      let idleRounds = 0;
      while (pending.length > 0) {
        yield* self.ensureRecoveryCurrent(generation);
        // Never schedule into a full queue: that would turn the recovery batch
        // itself into a queue-capacity drop. Wait for queued entries to drain.
        const capacity = self.maxQueuedReconciliations - self.scheduler.stats.queued;
        if (capacity <= 0) {
          idleRounds += 1;
          if (idleRounds > 64) {
            return yield* Effect.fail(new RecoveryPassFailure(
              { message: 'recovery batch could not drain the scheduler queue', unrecoverable: false, epochMismatch: false },
              new Error('scheduler-queue-stayed-full'),
            ));
          }
          yield* Effect.sleep(Duration.millis(1));
          continue;
        }
        idleRounds = 0;
        const chunk = pending.splice(0, capacity);
        yield* self.awaitSchedulerBatch(chunk);
      }
    });
  }

  /** Await one scheduler batch chunk; interruption abandons only the wait, not scheduler work. */
  private awaitSchedulerBatch(chunk: readonly string[]): Effect.Effect<void, RecoveryPassFailure> {
    const self = this;
    return Effect.tryPromise({
      try: (signal) => new Promise<void>((resolve) => {
        let settled = false;
        const settle = (): void => {
          if (settled) return;
          settled = true;
          resolve();
        };
        signal.addEventListener('abort', settle, { once: true });
        void self.scheduler.scheduleMany(chunk).then(settle, settle);
      }),
      catch: (cause) => new RecoveryPassFailure(classifyRecoveryError(cause), cause),
    });
  }

  private prioritizedActiveCommandIds(): string[] {
    const active = new Set(this.activeCommandIds());
    const prioritized: string[] = [];
    const seen = new Set<string>();
    for (const drop of this.pendingDrops) {
      if (!active.has(drop.commandId) || seen.has(drop.commandId)) continue;
      seen.add(drop.commandId);
      prioritized.push(drop.commandId);
    }
    for (const commandId of active) if (!seen.has(commandId)) prioritized.push(commandId);
    return prioritized;
  }

  /**
   * R3-08: a drop observed after the snapshot cannot be masked. Compensation is
   * bounded by maxCompensationPasses plus a progress proof (covered drops or
   * watermark advance); exhaustion is observable Unrecoverable, never Healthy.
   */
  private scheduleCompensationPass(generation: number): void {
    if (!this.isRecoveryCurrent(generation)) return;
    this.compensationAttempts += 1;
    this.needsNextAuthoritativePass = true;
    const current = { coveredDrops: this.coveredDropCount, sequence: this.authoritativeWatermark?.sequence };
    if (this.compensationBaseline === undefined) {
      this.compensationBaseline = current;
    } else if (this.compensationBaseline.coveredDrops === current.coveredDrops
      && this.compensationBaseline.sequence === current.sequence) {
      this.compensationNoProgressRounds += 1;
    } else {
      this.compensationBaseline = current;
      this.compensationNoProgressRounds = 0;
    }
    this.recordDiagnostic(
      'queue-capacity',
      'post-snapshot drop(s) remain: compensation attempt ' + this.compensationAttempts +
        '/' + this.recoveryOptions.maxCompensationPasses + ' coveredThisPass=' + this.coveredDropsThisPass,
    );
    if (this.compensationAttempts > this.recoveryOptions.maxCompensationPasses || this.compensationNoProgressRounds >= 2) {
      const unresolved = this.pendingDrops.length;
      this.pendingDrops = [];
      this.needsNextAuthoritativePass = false;
      this.lastError = 'authoritative recovery could not cover post-snapshot reconciliation drops';
      this.recordDiagnostic('error', this.lastError + ' (unresolved=' + unresolved + ')');
      this.activeRecoveryRequest = undefined;
      this.setPhase('Unrecoverable');
      return;
    }
    const delay = this.recoveryOptions.backoffMs[
      Math.min(this.compensationAttempts - 1, this.recoveryOptions.backoffMs.length - 1)
    ];
    this.nextRetryAt = this.retention.now() + delay;
    this.setPhase('WaitingRetry');
    this.clearRetryTimer();
    const expectedGeneration = generation;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.nextRetryAt = undefined;
      if (this.disposed || !this.started || this.recoveryGeneration !== expectedGeneration) return;
      this.setPhase('Dirty');
      this.scheduleRecoveryPass();
    }, delay);
  }

  /**
   * Classify one failed pass and schedule the bounded backoff retry. The owner
   * generation is checked first: a stale failure (stop/dispose/replacement) can
   * never change phase, counters or timers.
   */
  private handleRecoveryFailure(
    failure: RecoveryPassFailure,
    request: PendingRecoveryRequest,
    generation: number,
  ): void {
    if (!this.isRecoveryCurrent(generation)) return;
    const classified = failure.classified;
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
      this.recordDiagnostic(
        'error',
        'recovery stopped after ' + this.attempts + '/' + this.recoveryOptions.maxAttempts + ' attempt(s)',
      );
      return;
    }
    const delay = this.recoveryOptions.backoffMs[
      Math.min(this.attempts - 1, this.recoveryOptions.backoffMs.length - 1)
    ];
    this.nextRetryAt = this.retention.now() + delay;
    this.setPhase('WaitingRetry');
    this.clearRetryTimer();
    const expectedGeneration = generation;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.nextRetryAt = undefined;
      if (this.disposed || !this.started || this.recoveryGeneration !== expectedGeneration) return;
      this.setPhase('Dirty');
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
  // R3-05: a request timeout is a retryable recovery failure (bounded backoff).
  if (cause instanceof RecoveryTimeout) return { message, unrecoverable: false, epochMismatch: false };
  // R3-01/R3-03: a contract-violating authoritative response is retried only a
  // bounded number of times, never silently accepted.
  if (cause instanceof RecoveryProtocolError) return { message, unrecoverable: false, epochMismatch: false };
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

/** A journal watermark must be a finite, non-negative safe integer (never NaN/Infinity/negative). */
function isAuthoritativeSequence(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

interface JournalPageValidationContext {
  readonly fabId: string;
  /** Epoch of the first page; every page of one recovery must stay in it. */
  readonly epoch: string;
  /** Requested afterSequence; events must be strictly after it. */
  readonly cursorSequence: number;
  /** Previous page latestSequence (-1 for the first page); watermarks never regress. */
  readonly previousLatestSequence: number;
  /** Previous page firstRetainedSequence (-1 for the first page); retention only advances. */
  readonly previousFirstRetainedSequence: number;
}

/**
 * R3-01/R3-03: validate one journal page against the frozen recovery contract.
 * Returns a RecoveryNeedsAuthority reason, or undefined when the page is safe to
 * apply. It deliberately does NOT assert contiguous FAB sequences: the Site
 * sequence is global while the page is FAB-filtered, so [1,3,5,7] is legal.
 * Gaps are only authoritative when the server says hasGap (or the epoch changed).
 */
function validateJournalPage(page: CommandJournalPage, context: JournalPageValidationContext): string | undefined {
  // Server hasGap is authoritative: fall back to the authoritative list at once.
  if (page.hasGap) return 'journal page reported hasGap';
  if (page.epoch !== context.epoch) {
    return 'journal epoch changed between pages: ' + String(page.epoch) + ' != ' + context.epoch;
  }
  if (!isAuthoritativeSequence(page.firstRetainedSequence)) return 'journal firstRetainedSequence is not a finite non-negative integer';
  if (!isAuthoritativeSequence(page.latestSequence)) return 'journal latestSequence is not a finite non-negative integer';
  if (!isAuthoritativeSequence(page.nextAfterSequence)) return 'journal nextAfterSequence is not a finite non-negative integer';
  if (page.firstRetainedSequence > page.latestSequence + 1) {
    return 'journal firstRetainedSequence ' + page.firstRetainedSequence + ' exceeds latestSequence+1 ' + (page.latestSequence + 1);
  }
  // Same-epoch server watermarks never regress; new writes may increase them.
  if (context.previousFirstRetainedSequence > page.firstRetainedSequence) {
    return 'journal firstRetainedSequence moved backwards: ' + page.firstRetainedSequence + ' < ' + context.previousFirstRetainedSequence;
  }
  if (context.previousLatestSequence > page.latestSequence) {
    return 'journal latestSequence moved backwards: ' + page.latestSequence + ' < ' + context.previousLatestSequence;
  }
  // R3-01: a cursor before the retained window must never be treated as success.
  if (context.cursorSequence < page.firstRetainedSequence - 1) {
    return 'journal cursor ' + context.cursorSequence + ' is outside the retained window (firstRetainedSequence=' + page.firstRetainedSequence + ')';
  }
  if (context.cursorSequence > page.latestSequence) {
    return 'journal cursor ' + context.cursorSequence + ' is beyond latestSequence ' + page.latestSequence;
  }
  if (page.nextAfterSequence < context.cursorSequence) {
    return 'journal nextAfterSequence ' + page.nextAfterSequence + ' moved the cursor backwards from ' + context.cursorSequence;
  }
  if (page.nextAfterSequence > page.latestSequence) {
    return 'journal nextAfterSequence ' + page.nextAfterSequence + ' exceeds latestSequence ' + page.latestSequence;
  }
  if (context.cursorSequence < page.latestSequence && page.nextAfterSequence <= context.cursorSequence) {
    return 'journal page made no progress before the authoritative watermark ' + page.latestSequence;
  }
  let previousSequence = context.cursorSequence;
  for (const event of page.events) {
    if (event.fabId !== context.fabId) {
      return 'foreign FAB event: ' + String(event.fabId) + ' != ' + context.fabId;
    }
    if (!isAuthoritativeSequence(event.sequence)) return 'journal event sequence is not a finite non-negative integer';
    if (event.sequence <= previousSequence) {
      return 'non-monotonic journal event: ' + event.sequence + ' after ' + previousSequence;
    }
    if (event.sequence > page.nextAfterSequence) {
      return 'event beyond next cursor: ' + event.sequence + ' > ' + page.nextAfterSequence;
    }
    previousSequence = event.sequence;
  }
  return undefined;
}

/** R3-01/R3-07: an authoritative list snapshot must be internally consistent before it is applied. */
function validateRecoveryList(list: CommandRecoveryList, fabId: string): string | undefined {
  if (typeof list.epoch !== 'string' || list.epoch.length === 0) return 'recovery list epoch is not a non-empty string';
  if (!isAuthoritativeSequence(list.latestSequence)) return 'recovery list latestSequence is not a finite non-negative integer';
  for (const record of list.commands) {
    if (record.fabId !== fabId) {
      return 'recovery list contains a foreign FAB record: ' + String(record.fabId) + ' != ' + fabId;
    }
    if (!isAuthoritativeSequence(record.revision)) return 'recovery list record revision is not a finite non-negative integer';
  }
  return undefined;
}
