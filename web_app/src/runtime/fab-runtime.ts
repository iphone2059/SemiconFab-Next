import { Duration, Effect, Exit, Fiber, Option, Scope } from 'effect';
import type * as AtomRegistry from 'effect/reactivity/AtomRegistry';
import type {
  CommandConnectionStatus,
  CommandCursor,
  CommandEventSource,
  CommandResultEvent,
  CommandSourceAvailability,
  CommandStreamDirty,
  CommandStreamDirtyReason,
  CommandTransportFailure,
} from '@/contracts/command-events.contract';
import {
  resolveBackoffSchedule,
  resolveIntegerOption,
  resolveTimeoutOption,
} from '@/contracts/command-config';
import type {
  ReconciliationResult,
  ReconciliationResultStatus,
} from '@/runtime/fab-reconciliation-scheduler';
import type {
  CommandGateway,
  CommandGatewayError,
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
  readonly resolvedWorkflowTtlMs?: number;
  /** Hard cap on retained terminal workflows; the oldest terminal entries go first. */
  readonly maxResolvedWorkflows?: number;
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
  | 'Unavailable'
  /**
   * R4-06: the authoritative recovery authority is available but the realtime
   * command transport is not (permanently unavailable or failed). The HTTP state
   * may converge, but the runtime must never claim Healthy without a live
   * transport that can deliver command results.
   */
  | 'Degraded';

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
  | 'protocol-error'
  /** R4-02: a per-command reconciliation failed while the command still needs convergence. */
  | 'reconcile-failure'
  /** R4-06: the realtime command transport is permanently unavailable. */
  | 'realtime-unavailable'
  /** R4-08: authoritative recovery observed more active commands than the local admission bound. */
  | 'active-capacity';

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
/** R4-08: default per-FAB active command admission bound (aligned with the backend option). */
export const DEFAULT_MAX_ACTIVE_COMMANDS = 64;
/** R4-05: bounded consumer-fiber restarts before explicitly entering Unrecoverable. */
const MAX_SIGNAL_RESTARTS = 3;
const MAX_BRIDGE_RESTARTS = 3;

export interface FabRuntimeRecoveryOptions {
  /** Backoff schedule indexed by failed attempt (last value repeats). */
  readonly backoffMs?: readonly number[];
  /** Total attempts before Unrecoverable (default 8). */
  readonly maxAttempts?: number;
  /** Journal page limit sent to the gateway (backend clamps 1..1000). */
  readonly journalPageLimit?: number;
  /** Safety bound for the multi-page journal loop. */
  readonly maxJournalPages?: number;
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
  /**
   * R4-08: hard admission bound for simultaneously active commands of this FAB.
   * Mirrors the backend MaxActiveCommandsPerFab admission so the frontend never
   * creates an unbounded actor set that the server would reject anyway.
   */
  readonly maxActiveCommands?: number;
}

interface ResolvedRetention {
  readonly resolvedWorkflowTtlMs: number;
  readonly maxResolvedWorkflows: number;
  readonly maxRetainedProjections: number;
  readonly sweepIntervalMs: number;
  readonly now: () => number;
}

const DEFAULT_RETENTION: ResolvedRetention = {
  resolvedWorkflowTtlMs: 300_000,
  maxResolvedWorkflows: 64,
  maxRetainedProjections: 128,
  sweepIntervalMs: 15_000,
  now: Date.now,
};

function resolveRetention(options: FabRuntimeRetentionOptions | undefined): ResolvedRetention {
  // R4-07: strict fail-fast validation; Math.max silently accepted NaN/Infinity.
  return {
    resolvedWorkflowTtlMs: resolveTimeoutOption('retention.resolvedWorkflowTtlMs', options?.resolvedWorkflowTtlMs, DEFAULT_RETENTION.resolvedWorkflowTtlMs, { min: 0 }),
    maxResolvedWorkflows: resolveIntegerOption('retention.maxResolvedWorkflows', options?.maxResolvedWorkflows, DEFAULT_RETENTION.maxResolvedWorkflows, { min: 1, max: 100_000 }),
    maxRetainedProjections: resolveIntegerOption('retention.maxRetainedProjections', options?.maxRetainedProjections, DEFAULT_RETENTION.maxRetainedProjections, { min: 0, max: 100_000 }),
    sweepIntervalMs: resolveTimeoutOption('retention.sweepIntervalMs', options?.sweepIntervalMs, DEFAULT_RETENTION.sweepIntervalMs, { min: 1 }),
    now: options?.now ?? DEFAULT_RETENTION.now,
  };
}

interface ResolvedRecovery {
  readonly backoffMs: readonly number[];
  readonly maxAttempts: number;
  readonly journalPageLimit: number;
  readonly maxJournalPages: number;
  readonly requestTimeoutMs: number;
  readonly maxCompensationPasses: number;
}

function resolveRecovery(options: FabRuntimeRecoveryOptions | undefined): ResolvedRecovery {
  const fallback = DEFAULT_RECOVERY_BACKOFF_MS;
  // R4-07: a broken retry/size bound must fail fast, never silently degrade.
  return {
    backoffMs: resolveBackoffSchedule('recovery.backoffMs', options?.backoffMs, fallback),
    maxAttempts: resolveIntegerOption('recovery.maxAttempts', options?.maxAttempts, DEFAULT_RECOVERY_MAX_ATTEMPTS, { min: 1, max: 64 }),
    journalPageLimit: resolveIntegerOption('recovery.journalPageLimit', options?.journalPageLimit, DEFAULT_RECOVERY_JOURNAL_PAGE_LIMIT, { min: 1, max: 1000 }),
    maxJournalPages: resolveIntegerOption('recovery.maxJournalPages', options?.maxJournalPages, DEFAULT_MAX_JOURNAL_PAGES, { min: 1, max: 1_000_000 }),
    requestTimeoutMs: resolveTimeoutOption('recovery.requestTimeoutMs', options?.requestTimeoutMs, DEFAULT_RECOVERY_REQUEST_TIMEOUT_MS, { min: 1 }),
    maxCompensationPasses: resolveIntegerOption('recovery.maxCompensationPasses', options?.maxCompensationPasses, DEFAULT_MAX_COMPENSATION_PASSES, { min: 0, max: 64 }),
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
  readonly lossBarrier: number;
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
  readonly connectionStatus: CommandConnectionStatus;
  /** R3-07: explicit authority; `unavailable` runtimes never report Healthy. */
  readonly availability: CommandRecoveryAvailability;
  /**
   * R4-06: realtime transport availability, kept separate from the recovery
   * authority. A runtime whose transport is unavailable can converge its HTTP
   * state but is Degraded, never Healthy.
   */
  readonly realtimeAvailability: CommandSourceAvailability;
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

/**
 * R4-08: the frontend admission bound for simultaneously active commands was
 * reached. Mirrors the backend MaxActiveCommandsPerFab rejection: no workflow,
 * actor or CommandScope is created for the rejected submission.
 */
export class ActiveCommandCapacityError extends Error {
  constructor(
    readonly fabId: string,
    readonly commandId: string,
    readonly capacity: number,
  ) {
    super('active command capacity (' + capacity + ') reached for FAB ' + fabId + '; command ' + commandId + ' was not admitted');
    this.name = 'ActiveCommandCapacityError';
  }
}

export interface CommandAdmissionReservation {
  readonly siteId: string;
  readonly fabId: string;
  readonly state: 'reserved' | 'committed' | 'released';
  commit(commandId: string): void;
  release(): void;
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
  private readonly reservations = new Map<string, CommandAdmissionReservation>();
  private readonly commandScopes = new Map<string, Scope.Closeable>();
  private readonly resolvedAt = new Map<string, number>();
  private readonly projectionSubscriptions = new Map<string, () => void>();
  private readonly signalFibers: Array<Fiber.Fiber<void, never>> = [];
  private readonly signalDefinitions: Array<{ readonly label: string; readonly start: () => void }> = [];
  private readonly pendingSignalRestarts = new Set<string>();
  private readonly signalRestartCounts = new Map<string, number>();
  private signalRestartTimer?: ReturnType<typeof setTimeout>;

  private started = false;
  private disposed = false;
  private bridgeStarted = false;
  /** R4-05: true only while stop()/dispose() interrupt consumers (an expected exit). */
  private stopping = false;
  private bridgeRestartAttempts = 0;
  private bridgeRestartTimer?: ReturnType<typeof setTimeout>;
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
  /** Highest generation coalesced when the bounded intent queue overflows. */
  private overflowDropGeneration = 0;
  private coveredDropsTotal = 0;
  private coveredDropsThisPass = 0;
  private compensationAttempts = 0;
  private compensationNoProgressRounds = 0;
  private compensationBaseline: { readonly coveredDrops: number; readonly sequence: number | undefined } | undefined;
  private needsNextAuthoritativePass = false;
  /** R3-08: suppress per-record reconcile scheduling while an authoritative snapshot is applied. */
  private suppressSnapshotScheduling = false;
  private lastSnapshotState?: CommandRecoverySnapshotState;
  private phase: CommandRecoveryPhase = 'Degraded';
  private attempts = 0;
  private lastError?: string;
  private lastDirtyCause?: CommandRecoveryDirtyCause;
  private recoveryCursor?: CommandCursor;
  private nextRetryAt?: number;
  private lastRecoveredAt?: number;
  private authoritativeWatermark?: CommandCursor;
  private readonly recoveryDiagnosticLog: CommandRecoveryDiagnostic[] = [];

  /** R4-06: realtime transport availability, tracked separately from recovery authority. */
  private realtimeAvailability: CommandSourceAvailability = 'ready';
  private readonly maxActiveCommands: number;
  private readonly maxConcurrentReconciliations: number;
  private readonly reconcileTimeoutMs: number;
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
    // R4-07: every public bound is validated at construction, never silently coerced.
    this.maxQueuedReconciliations = resolveIntegerOption(
      'maxQueuedReconciliations',
      options.maxQueuedReconciliations,
      DEFAULT_MAX_QUEUED_RECONCILIATIONS,
      { min: 1, max: 100_000 },
    );
    this.maxConcurrentReconciliations = resolveIntegerOption(
      'maxConcurrentReconciliations',
      options.maxConcurrentReconciliations,
      4,
      { min: 1, max: 64 },
    );
    this.reconcileTimeoutMs = resolveTimeoutOption(
      'reconcileTimeoutMs',
      options.reconcileTimeoutMs,
      10_000,
      { min: 1 },
    );
    this.maxActiveCommands = resolveIntegerOption(
      'maxActiveCommands',
      options.maxActiveCommands,
      DEFAULT_MAX_ACTIVE_COMMANDS,
      { min: 1, max: 4_096 },
    );

    // FabScope is the only Scope this class closes; its children are created from it.
    this.fabScope = Scope.forkUnsafe(options.parentScope);
    this.transportScope = Scope.forkUnsafe(this.fabScope);
    // R3-05: the RecoveryScope is a FabScope child; every recovery pass fiber (and
    // its journal/list request) is owned by it and interrupted on dispose.
    this.recoveryScope = Scope.forkUnsafe(this.fabScope);
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
    const correlationCapacity = this.maxActiveCommands + this.retention.maxResolvedWorkflows;
    this.correlation = new CommandCorrelationRegistry({
      maxTerminalEntries: this.retention.maxResolvedWorkflows,
      // R4-08: the hard absolute cap is aligned with the active admission bound plus
      // the retained terminal capacity; it is a real cap (active entries included).
      maxEntries: correlationCapacity,
      now: this.retention.now,
    });
    this.scheduler = new FabReconciliationScheduler({
      fabId: options.fabId,
      runtime: options.runtime,
      parentScope: this.fabScope,
      physicalBudget: this.physicalBudget,
      gateway: options.gateway,
      resolve: (commandId) => this.resolveReconciliationTarget(commandId),
      applyAuthoritative: (event) => isAuthoritativeApplyOutcome(this.bridge.receiveAuthoritative(event)),
      isTerminal: (commandId) => this.isTerminalCommand(commandId),
      maxConcurrent: this.maxConcurrentReconciliations,
      maxQueued: this.maxQueuedReconciliations,
      timeoutMs: this.reconcileTimeoutMs,
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
    this.realtimeAvailability = this.source.availability;
    // HTTP authority and realtime capability are independent.
    this.recoveryAvailable = options.gateway !== undefined;
    if (!this.recoveryAvailable) {
      this.phase = 'Unavailable';
      this.recordDiagnostic('no-authority', 'authoritative command gateway is not configured: recovery unavailable');
    }
    const registry: CommandWorkflowRegistry = {
      get: (fabId, commandId) => (fabId === this.fabId ? this.workflows.get(commandId) : undefined),
    };
    this.bridge = new CommandEventBridge(this.source, registry, {
      fabId: options.fabId,
      correlation: this.correlation,
      recovery: this.recovery,
      onResultDelivered: (event) => { this.afterDelivery(event.commandId); },
      // R4-03/R4-05: rejected actor application and consumer-fiber termination are
      // owner-visible; the bridge never silently drops either.
      onRejected: (event) => this.onBridgeRejected(event),
      onDefect: (cause) => this.onBridgeDefect(cause),
      onConsumerExit: (exit) => this.onBridgeConsumerExit(exit),
      runtime: options.runtime,
      scope: this.transportScope,
    });
  }

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.stopping = false;
    this.bridgeRestartAttempts = 0;
    this.signalRestartCounts.clear();
    this.subscribeSignals();
    if (!this.lazyCommandSubscription || this.workflows.size > 0) {
      this.bridge.start();
      this.bridgeStarted = true;
    }
    this.refreshRealtimeAvailability();
    if (!this.recoveryAvailable) {
      // R3-07/R4-06: display-only composition. Transport signals still deliver live
      // events to actors, but no recovery request/timer exists and the phase is
      // permanently Unavailable (never Healthy, never Unrecoverable).
      this.setPhase('Unavailable');
      this.recordDiagnostic(
        this.realtimeAvailability === 'unavailable' ? 'realtime-unavailable' : 'no-authority',
        'start(): authoritative command recovery unavailable; live events only, phase stays Unavailable',
      );
      this.scheduleSweep();
      return;
    }
    if (this.realtimeAvailability === 'unavailable') {
      // R4-06: HTTP authority exists but no live transport: converge may still run,
      // but the observable phase is Degraded until recovery proves otherwise.
      this.setPhase('Degraded');
      this.recordDiagnostic('realtime-unavailable', 'start(): realtime command transport unavailable; runtime stays Degraded');
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
    // R4-05: consumer exits caused by stop()/dispose() are expected and must not
    // be reported as defects or trigger a bounded restart.
    this.stopping = true;
    this.interruptRecoveryPass();
    this.clearRetryTimer();
    this.clearBridgeRestartTimer();
    this.clearSignalRestartTimer();
    this.pendingSignalRestarts.clear();
    this.nextRetryAt = undefined;
    if (this.recoveryAvailable && this.phase !== 'Unrecoverable' && this.phase !== 'Unavailable') {
      // Paused while dirty: observable and never Healthy until a new snapshot.
      this.setPhase(this.phase === 'Degraded' ? 'Degraded' : 'Dirty');
    }
    if (this.bridgeStarted) {
      this.bridgeStarted = false;
      this.bridge.stop();
    }
    for (const fiber of this.signalFibers) stopCommandStream(this.runtime, fiber);
    this.signalFibers.length = 0;
    this.clearSweepTimer();
    this.stopping = false;
  }

  /**
   * Create the workflow for a submitted command; replays results held before
   * registration. R4-08: this is the hard frontend admission point — a new active
   * command beyond maxActiveCommands is rejected before any actor/Scope exists.
   */
  reserveCommandAdmission(idempotencyKey: string): CommandAdmissionReservation {
    if (this.disposed) throw new Error('FAB runtime is disposed');
    const existing = this.reservations.get(idempotencyKey);
    if (existing) return existing;
    if (this.countActiveCommands() + this.reservations.size >= this.maxActiveCommands) {
      throw new ActiveCommandCapacityError(this.fabId, idempotencyKey, this.maxActiveCommands);
    }
    let state: CommandAdmissionReservation['state'] = 'reserved';
    const reservation: CommandAdmissionReservation = {
      siteId: this.siteId,
      fabId: this.fabId,
      get state() { return state; },
      commit: (commandId) => {
        if (state !== 'reserved') throw new Error('command reservation is no longer reserved');
        state = 'committed';
        this.reservations.delete(idempotencyKey);
        try {
          this.registerAcceptedCommand(commandId);
        } catch (cause) {
          this.enterDirty({ listOnly: true, cause: 'protocol-error' });
          throw cause;
        }
      },
      release: () => {
        if (state !== 'reserved') throw new Error('command reservation is no longer reserved');
        state = 'released';
        this.reservations.delete(idempotencyKey);
      },
    };
    this.reservations.set(idempotencyKey, reservation);
    return reservation;
  }

  registerAcceptedCommand(commandId: string): CommandWorkflow {
    if (this.disposed) throw new Error('FAB runtime is disposed');
    const existing = this.workflows.get(commandId);
    if (existing) return existing;
    if (this.countActiveCommands() >= this.maxActiveCommands) {
      this.recordDiagnostic('active-capacity', 'accepted command exceeds local active bound: ' + commandId);
      this.enterDirty({ listOnly: true, cause: 'active-capacity' });
    }
    return this.createTrackedWorkflow(commandId);
  }

  ownsReservation(reservation: CommandAdmissionReservation): boolean {
    return [...this.reservations.values()].includes(reservation);
  }

  requestAuthoritativeRecovery(): void {
    this.enterDirty({ listOnly: true, cause: 'protocol-error' });
  }

  /**
   * R4-03: an authoritative List/Journal record may legitimately predate this
   * runtime (e.g. page refresh with many active commands). Admission is enforced
   * by the backend for new submissions, so recovery mirrors authority even if a
   * lowered local bound makes the visible set larger; the overflow is observable,
   * never silently dropped.
   */
  private trackAuthoritativeCommand(commandId: string): CommandWorkflow {
    if (this.disposed) throw new Error('FAB runtime is disposed');
    const existing = this.workflows.get(commandId);
    if (existing) return existing;
    if (this.countActiveCommands() >= this.maxActiveCommands) {
      this.recordDiagnostic(
        'active-capacity',
        'authoritative snapshot exceeds local active command bound (' + this.maxActiveCommands + '); command ' + commandId + ' admitted from authority',
      );
    }
    return this.createTrackedWorkflow(commandId);
  }

  private createTrackedWorkflow(commandId: string): CommandWorkflow {
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
    const flushed = this.bridge.flushRecovery();
    if (flushed.rejected > 0) {
      // R4-03: a held result the actor rejected is not dropped; authoritative
      // recovery must reapply it from the backend.
      this.enterDirty({ listOnly: true, cause: 'protocol-error' });
    }
    this.afterDelivery(commandId);
    const revision = workflow.projection?.revision ?? -1;
    // R3-08: while an authoritative snapshot is being applied, recovered commands
    // are converged by the bounded post-recovery batch, not by one reconcile per
    // tracked record (that is what used to overflow the 128-item scheduler queue).
    if (!this.suppressSnapshotScheduling && (this.phase !== 'Healthy' || !this.hasLocalEvidence(commandId) || revision < 0)) {
      // R4-02: fire-and-forget scheduling is never silent — a failed/timed-out
      // reconciliation for a command that still needs convergence enters Dirty and
      // is retried by a bounded authoritative pass.
      void this.scheduler.schedule(commandId).then(
        (result) => this.observeScheduledResult(result),
        (cause) => this.observeScheduledFailure(commandId, cause),
      );
    }
    return workflow;
  }

  /**
   * R4-08: O(1) admission count. Reading every workflow.projection here would
   * make registration O(N) per command (audited by the retention tests); the
   * terminal index is maintained by recordTerminal/evictWorkflow instead.
   */
  private countActiveCommands(): number {
    return this.workflows.size - this.resolvedAt.size;
  }

  /** R4-02: classify a fire-and-forget reconciliation result. */
  private observeScheduledResult(result: ReconciliationResult): void {
    if (this.disposed || !this.started) return;
    if (!isReconciliationFailure(result.status)) return;
    if (this.isTerminalCommand(result.commandId)) return;
    this.recordDiagnostic(
      'reconcile-failure',
      'command ' + result.commandId + ' reconciliation ' + result.status + (result.error !== undefined ? ': ' + result.error : ''),
    );
    this.enterDirty({ listOnly: true, cause: 'reconcile-failure' });
  }

  private observeScheduledFailure(commandId: string, cause: unknown): void {
    if (this.disposed || !this.started) return;
    this.recordDiagnostic('reconcile-failure', 'scheduler rejected command ' + commandId);
    this.lastError = cause instanceof Error ? cause.message : String(cause);
    this.enterDirty({ listOnly: true, cause: 'reconcile-failure' });
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
    return this.correlation.lastObservedRevision(this.fabId, commandId) !== undefined ||
      this.bridge.recoveryQueue.pendingFor(this.fabId, commandId).length > 0;
  }

  /** Converge one command with the backend; true only when a result was delivered. */
  reconcileCommand(commandId: string): Promise<boolean> {
    return this.scheduler.schedule(commandId).then((result) => result.status === 'succeeded');
  }

  /** R4-02: explicit per-command reconciliation result (typed status, never a boolean loss). */
  reconcileCommandResult(commandId: string): Promise<ReconciliationResult> {
    return this.scheduler.schedule(commandId);
  }

  /** Authoritative reconciliation for every tracked command through the one scheduler. */
  reconcileAll(): Promise<number> {
    return this.reconcileTracked(this.workflows.keys());
  }

  /** Reconcile only the given tracked commands; terminal/evicted ids are ignored. */
  reconcileTracked(commandIds: Iterable<string>): Promise<number> {
    return this.reconcileTrackedResults(commandIds).then((results) =>
      results.filter((result) => result.status === 'succeeded').length,
    );
  }

  /** R4-02: per-command results for an explicit reconciliation batch. */
  reconcileTrackedResults(commandIds: Iterable<string>): Promise<readonly ReconciliationResult[]> {
    const unique = [...new Set(commandIds)].filter((commandId) => {
      const workflow = this.workflows.get(commandId);
      return workflow !== undefined && !this.isTerminalCommand(commandId);
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
      connectionStatus: this.connectionStatus,
      availability: this.recoveryAvailable ? 'available' : 'unavailable',
      realtimeAvailability: this.realtimeAvailability,
      attempts: this.attempts,
      maxAttempts: this.recoveryOptions.maxAttempts,
      recoveryGeneration: this.recoveryGeneration,
      recovering: this.passRunning,
      recoveryPending: this.recoveryPending || this.pendingRecovery !== undefined,
      needsNextAuthoritativePass: this.needsNextAuthoritativePass,
      coveredDropCount: this.coveredDropsTotal,
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
    return this.pendingDrops.length + (this.overflowDropGeneration > 0 ? 1 : 0);
  }

  /** R3-08: total drops proven covered by authoritative snapshots (test/UI evidence). */
  get coveredDropCount(): number {
    return this.coveredDropsTotal;
  }

  /** ADR-011 §2.2: the FAB-wide physical HTTP slots shared by recovery + reconciliation. */
  get physicalRequestStats(): PhysicalRequestStats {
    return { capacity: this.physicalBudget.capacity, inFlight: this.physicalBudget.inFlight };
  }

  get workflowCount(): number {
    return this.workflows.size;
  }

  /** R4-08: hard frontend admission bound mirrored from the backend option. */
  get activeCommandCapacity(): number {
    return this.maxActiveCommands;
  }

  /** R4-08: currently admitted active commands (terminal retention excluded). */
  get activeCommandCount(): number {
    return this.countActiveCommands();
  }

  get terminalWorkflowCount(): number {
    return this.resolvedAt.size;
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
    this.clearBridgeRestartTimer();
    this.clearSignalRestartTimer();
    this.pendingSignalRestarts.clear();
    this.pendingRecovery = undefined;
    this.activeRecoveryRequest = undefined;
    this.pendingDrops = [];
    this.overflowDropGeneration = 0;
    for (const reservation of this.reservations.values()) reservation.release();
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
    this.resolvedAt.clear();
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
    const subscribe = <A>(
      label: string,
      stream: import('effect').Stream.Stream<A>,
      handler: (value: A) => void,
    ): void => {
      const definition: { label: string; start: () => void } = {
        label,
        start: () => {
          const fiber = runCommandStream(this.runtime, this.transportScope, stream, handler, {
            label,
            onDefect: (streamLabel, cause) => this.onSignalDefect(streamLabel, cause),
            onExit: (streamLabel, exit) => this.onSignalExit(streamLabel, exit),
          });
          this.signalFibers.push(fiber);
        },
      };
      this.signalDefinitions.push(definition);
      definition.start();
    };
    if (this.source.gaps) {
      subscribe('gaps', this.source.gaps, (gap) => {
        // R4-04: a replay-gap is a safe-recovery trigger, never a journal
        // continuation. The control frame has no id: line, so no epoch/sequence
        // pair from it may be used as a recovery cursor (the parser also refuses
        // to combine the payload epoch with an inherited lastEventId).
        this.recordDiagnostic(
          'replay-gap',
          'backend replay could not cover a disconnect' + (gap.epoch !== undefined ? ' (epoch=' + gap.epoch + ')' : ''),
        );
        this.enterDirty({ listOnly: true, cause: 'replay-gap' });
      });
    }
    if (this.source.reconnected) {
      subscribe('reconnected', this.source.reconnected, () => {
        // ADR-010 §2: reconnects resume from the acknowledged cursor, never from
        // the observed one; without an acknowledged cursor the list is authoritative.
        const cursor = this.acknowledgedCursor();
        this.enterDirty({ ...(cursor !== undefined ? { cursor } : {}), listOnly: cursor === undefined, cause: 'reconnect' });
      });
    }
    if (this.source.transportFailures) {
      subscribe('transport-failures', this.source.transportFailures, (failure) => {
        this.lastTransportFailure = failure;
        this.refreshRealtimeAvailability();
        const cursor = this.acknowledgedCursor();
        this.enterDirty({ ...(cursor !== undefined ? { cursor } : {}), listOnly: cursor === undefined, cause: 'transport-failure' });
      });
    }
    subscribe('connection-status', this.source.connectionStatus, (status) => {
      const previous = this.connectionStatus;
      this.connectionStatus = status;
      this.refreshRealtimeAvailability();
      if (status !== 'open' && this.phase === 'Healthy') this.setPhase('Degraded');
      if (this.started && this.recoveryAvailable && status !== previous) {
        if (status === 'open' || status === 'reconnecting' || status === 'failed') {
          this.enterDirty({ listOnly: true, cause: status === 'open' ? 'reconnect' : 'transport-failure' });
          if (status !== 'open' && this.phase !== 'Recovering') this.setPhase('Degraded');
        }
      }
    });
    if (this.source.dirty) {
      subscribe('dirty', this.source.dirty, (dirty) => this.onDirty(dirty));
    }
  }

  /** R4-05: a consumer handler defect is a bounded diagnostic + Dirty, never a silent fiber death. */
  private onSignalDefect(label: string, cause: unknown): void {
    if (this.disposed) return;
    this.lastError = cause instanceof Error ? cause.message : String(cause);
    this.recordDiagnostic('protocol-error', 'stream consumer "' + label + '" handler failed');
    if (this.started) this.enterDirty({ listOnly: true, cause: 'protocol-error' });
  }

  /**
   * R4-05: the owner observes every signal consumer's termination. An expected
   * stop/dispose is ignored; an unexpected death is diagnosed and met with a
   * bounded restart (and authoritative recovery for the lost signal window), then
   * explicitly Unrecoverable after the restart budget is exhausted.
   */
  private onSignalExit(label: string, exit: Exit.Exit<void, never>): void {
    if (this.disposed || this.stopping || !this.started) return;
    this.refreshRealtimeAvailability();
    if (!this.recoveryAvailable) return;
    this.recordDiagnostic('protocol-error', 'stream consumer "' + label + '" terminated (' + (Exit.isSuccess(exit) ? 'ended' : 'failed') + ')');
    if (this.realtimeAvailability === 'unavailable') {
      if (this.phase !== 'Unrecoverable') this.setPhase('Degraded');
      this.enterDirty({ listOnly: true, cause: 'realtime-unavailable' });
      return;
    }
    const attempts = (this.signalRestartCounts.get(label) ?? 0) + 1;
    this.signalRestartCounts.set(label, attempts);
    if (attempts > MAX_SIGNAL_RESTARTS) {
      this.lastError = 'stream consumer "' + label + '" terminated ' + attempts + ' times';
      this.recordDiagnostic('error', this.lastError);
      this.setPhase('Unrecoverable');
      return;
    }
    this.enterDirty({ listOnly: true, cause: 'protocol-error' });
    this.pendingSignalRestarts.add(label);
    this.scheduleSignalRestart();
  }

  private scheduleSignalRestart(): void {
    if (this.signalRestartTimer !== undefined) return;
    this.signalRestartTimer = setTimeout(() => {
      this.signalRestartTimer = undefined;
      if (this.disposed || !this.started || this.stopping) return;
      for (const label of [...this.pendingSignalRestarts]) {
        this.pendingSignalRestarts.delete(label);
        const definition = this.signalDefinitions.find((candidate) => candidate.label === label);
        if (definition !== undefined) definition.start();
      }
    }, 1);
  }

  /** R4-05: bounded restart of the command-result consumer; never "dead fiber, running=true". */
  private onBridgeConsumerExit(exit: Exit.Exit<void, never>): void {
    if (this.disposed) return;
    const wasTracked = this.bridgeStarted;
    this.bridgeStarted = false;
    if (this.stopping || !this.started) return;
    this.refreshRealtimeAvailability();
    if (!wasTracked || !this.recoveryAvailable) return;
    this.recordDiagnostic('protocol-error', 'command result consumer terminated (' + (Exit.isSuccess(exit) ? 'ended' : 'failed') + ')');
    if (this.realtimeAvailability === 'unavailable') {
      if (this.phase !== 'Unrecoverable') this.setPhase('Degraded');
      this.enterDirty({ listOnly: true, cause: 'realtime-unavailable' });
      return;
    }
    this.bridgeRestartAttempts += 1;
    if (this.bridgeRestartAttempts > MAX_BRIDGE_RESTARTS) {
      this.lastError = 'command result consumer terminated ' + this.bridgeRestartAttempts + ' times';
      this.recordDiagnostic('error', this.lastError);
      this.setPhase('Unrecoverable');
      return;
    }
    this.enterDirty({ listOnly: true, cause: 'protocol-error' });
    this.clearBridgeRestartTimer();
    this.bridgeRestartTimer = setTimeout(() => {
      this.bridgeRestartTimer = undefined;
      if (this.disposed || !this.started || this.stopping || this.bridgeStarted) return;
      if (!this.lazyCommandSubscription || this.workflows.size > 0) {
        this.bridge.start();
        this.bridgeStarted = true;
      }
    }, 1);
  }

  /** R4-03: the actor rejected an event; it must not be silently dropped. */
  private onBridgeRejected(event: CommandResultEvent): void {
    if (this.disposed) return;
    this.recordDiagnostic(
      'protocol-error',
      'actor rejected event for command ' + event.commandId + ' revision ' + event.revision,
    );
    if (this.started) this.enterDirty({ listOnly: true, cause: 'protocol-error' });
  }

  private onBridgeDefect(cause: unknown): void {
    if (this.disposed) return;
    this.lastError = cause instanceof Error ? cause.message : String(cause);
    this.recordDiagnostic('decode-error', 'command result consumer handler failed');
    if (this.started) this.enterDirty({ listOnly: true, cause: 'protocol-error' });
  }

  private clearSignalRestartTimer(): void {
    if (this.signalRestartTimer === undefined) return;
    clearTimeout(this.signalRestartTimer);
    this.signalRestartTimer = undefined;
  }

  private clearBridgeRestartTimer(): void {
    if (this.bridgeRestartTimer === undefined) return;
    clearTimeout(this.bridgeRestartTimer);
    this.bridgeRestartTimer = undefined;
  }

  /**
   * R4-06: keep recovery-authority availability (gateway + source readiness) and
   * realtime transport availability separate. Losing the live transport after a
   * ready start degrades the observable phase; it never stays Healthy.
   */
  private refreshRealtimeAvailability(): void {
    const availability = this.source.availability;
    if (availability === this.realtimeAvailability) return;
    this.realtimeAvailability = availability;
    if (this.disposed || this.stopping) return;
    if (availability === 'unavailable') {
      this.recordDiagnostic('realtime-unavailable', 'realtime command transport became unavailable');
      if (this.recoveryAvailable && this.phase !== 'Unrecoverable' && this.phase !== 'Unavailable') {
        this.setPhase('Degraded');
      }
      return;
    }
    if (this.recoveryAvailable && this.phase === 'Degraded') {
      this.setPhase('Dirty');
      this.enterDirty({ listOnly: true, cause: 'reconnect' });
    }
  }

  private acknowledgedCursor(): CommandCursor | undefined {
    const cursors = (this.source as { cursors?: { acknowledged?: CommandCursor } }).cursors;
    return cursors?.acknowledged;
  }

  private onDirty(dirty: CommandStreamDirty): void {
    this.lastDirty = dirty;
    this.refreshRealtimeAvailability();
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
    const lossBarrier = this.source.lossGeneration;
    this.coveredDropsThisPass = 0;
    const program = this.executeRecoveryEffect(generation, request, dropsAtStart, lossBarrier).pipe(
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
    while (this.pendingDrops.length > MAX_PENDING_RECOVERY_DROPS) {
      const dropped = this.pendingDrops.shift();
      if (dropped) {
        this.overflowDropGeneration = dropped.generation;
        this.mergeRecoveryRequest({ listOnly: true, cause: 'queue-capacity' });
      }
    }
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
    if (this.pendingDrops.length === 0 && this.overflowDropGeneration === 0) return 0;
    const remaining: RecoveryDropIntent[] = [];
    let covered = 0;
    for (const drop of this.pendingDrops) {
      if (drop.generation <= dropBarrier) covered += 1;
      else remaining.push(drop);
    }
    this.pendingDrops = remaining;
    if (this.overflowDropGeneration > 0 && this.overflowDropGeneration <= dropBarrier) {
      this.overflowDropGeneration = 0;
      covered += 1;
    }
    if (covered > 0) {
      this.coveredDropsTotal += covered;
      this.coveredDropsThisPass += covered;
      this.recordDiagnostic('queue-capacity', covered + ' drop(s) covered by authoritative recovery generation ' + this.recoveryGeneration);
    }
    return covered;
  }

  private setPhase(phase: CommandRecoveryPhase): void {
    this.phase = this.recoveryAvailable && this.source.availability === 'unavailable' ? 'Degraded' : phase;
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
    lossBarrier: number,
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
        return self.listRecoveryEffect(generation, gateway, dropsAtStart, lossBarrier);
      }
      return self.journalRecoveryEffect(generation, gateway, start, dropsAtStart, lossBarrier).pipe(
        Effect.catch((cause: RecoveryNeedsAuthority | RecoveryPassFailure) => {
          if (cause instanceof RecoveryNeedsAuthority) {
            self.recordDiagnostic('replay-gap', cause.message);
            return self.listRecoveryEffect(generation, gateway, dropsAtStart, lossBarrier);
          }
          if (cause.classified.epochMismatch) {
            self.recordDiagnostic('replay-gap', cause.message);
            return self.listRecoveryEffect(generation, gateway, dropsAtStart, lossBarrier);
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
    lossBarrier: number,
  ): Effect.Effect<RecoverySnapshot, RecoveryPassFailure> {
    const self = this;
    return Effect.gen(function* () {
      yield* self.ensureRecoveryCurrent(generation);
      const localActiveAtSnapshotStart = self.activeCommandIds();
      const heldAtSnapshotStart = self.bridge.recoveryQueue.snapshot();
      const list = yield* self.recoveryRequestEffect(
        generation,
        gateway.listFabCommands(self.siteId, self.fabId, 'all'),
      );
      yield* self.ensureRecoveryCurrent(generation);
      const protocolError = validateRecoveryList(list, self.siteId, self.fabId);
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
          if (record.terminal && !self.workflows.has(record.commandId)) continue;
          if (!record.terminal) self.trackAuthoritativeCommand(record.commandId);
          // R4-03: authoritative application bypasses the observed-revision
          // duplicate gate, so a snapshot can always repair an event the actor
          // never applied (even if the same revision was observed via SSE).
          const outcome = self.bridge.receiveAuthoritative({
            fabId: record.fabId,
            commandId: record.commandId,
            revision: record.revision,
            outcome: record.outcome,
            occurredAt: record.occurredAt,
          }, record.revision);
          if (!isAuthoritativeApplyOutcome(outcome)) {
            return yield* Effect.fail(new RecoveryPassFailure(
              classifyRecoveryError(new RecoveryProtocolError(
                'authoritative list record could not be applied: command ' + record.commandId + ' revision ' + record.revision + ' (' + outcome + ')',
              )),
              new RecoveryProtocolError('list record rejected by actor'),
            ));
          }
          appliedRecords += 1;
        }
        const authoritativeIds = new Set(list.commands.map((record) => record.commandId));
        const recordsById = new Map(list.commands.map((record) => [record.commandId, record]));
        for (const commandId of localActiveAtSnapshotStart) {
          if (authoritativeIds.has(commandId) || self.isTerminalCommand(commandId)) continue;
          const workflow = self.workflows.get(commandId);
          if (!workflow) continue;
          workflow.markExpiredUnresolved();
          if (workflow.projection?.recoveryDisposition !== 'expired-unresolved') {
            return yield* Effect.fail(new RecoveryPassFailure(
              classifyRecoveryError(new RecoveryProtocolError('workflow could not enter expired-unresolved')),
              new RecoveryProtocolError('expiration rejected'),
            ));
          }
          self.afterDelivery(commandId);
        }
        for (const held of heldAtSnapshotStart) {
          const record = recordsById.get(held.commandId);
          if (record === undefined || (record.terminal && !self.workflows.has(held.commandId) && record.revision >= held.revision)) {
            self.bridge.recoveryQueue.release(held);
          }
        }
        const flushed = self.bridge.flushRecovery();
        if (flushed.rejected > 0 || flushed.held > 0) {
          return yield* Effect.fail(new RecoveryPassFailure(
            classifyRecoveryError(new RecoveryProtocolError('held command result was rejected by its actor during list recovery')),
            new RecoveryProtocolError('flush rejected'),
          ));
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
        lossBarrier,
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
    lossBarrier: number,
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
          // R4-03: journal replay is authoritative, not SSE de-duplication.
          const outcome = self.bridge.receiveAuthoritative(toResultEvent(event), event.revision);
          if (!isAuthoritativeApplyOutcome(outcome)) {
            return yield* Effect.fail(new RecoveryNeedsAuthority(
              'authoritative journal event could not be applied: command ' + event.commandId + ' revision ' + event.revision + ' (' + outcome + ')',
            ));
          }
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
            lossBarrier,
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
      // R4-02: the snapshot records the authoritative watermark, but it neither
      // resets the retry budget nor signs the transport ACK yet. Cover and Healthy
      // are committed only after the post-snapshot reconciliation batch proves
      // that every still-active command converged.
      self.noteAuthoritativeSnapshot(snapshot);
      self.lastSnapshotState = {
        generation: snapshot.generation,
        kind: snapshot.kind,
        epoch: snapshot.epoch,
        sequence: snapshot.sequence,
        pages: snapshot.pages,
        appliedRecords: snapshot.appliedRecords,
        dropBarrier: snapshot.dropBarrier,
        coveredDrops: 0,
        needsNextAuthoritativePass: self.overflowDropGeneration > snapshot.dropBarrier || self.pendingDrops.some((drop) => drop.generation > snapshot.dropBarrier),
        startedAt: snapshot.startedAt,
        finishedAt: snapshot.finishedAt,
      };
      self.recoveryBatchRunning = true;
      const results = yield* self.reconcileActiveBatchEffect(generation).pipe(
        Effect.ensuring(Effect.sync(() => {
          self.recoveryBatchRunning = false;
        })),
      );
      yield* self.ensureRecoveryCurrent(generation);
      // R4-02: a failed/timed-out/cancelled/dropped reconciliation for a command
      // that still needs convergence fails the pass (bounded backoff); it can never
      // complete as Healthy. Drops are handled by the generation-stamped drop
      // intents, so only unrecorded drops are treated as pass failures.
      const batchFailure = self.batchFailure(results);
      if (batchFailure !== undefined) {
        self.lastSnapshotState = self.lastSnapshotState === undefined
          ? undefined
          : { ...self.lastSnapshotState, needsNextAuthoritativePass: true };
        return yield* Effect.fail(new RecoveryPassFailure(
          { message: batchFailure, unrecoverable: false, epochMismatch: true },
          new Error('reconciliation-batch-incomplete'),
        ));
      }
      if (self.overflowDropGeneration > snapshot.dropBarrier || self.pendingDrops.some((drop) => drop.generation > snapshot.dropBarrier)) {
        self.needsNextAuthoritativePass = true;
        const previous = self.lastSnapshotState;
        if (previous !== undefined) self.lastSnapshotState = { ...previous, needsNextAuthoritativePass: true };
        self.scheduleCompensationPass(generation);
        return;
      }
      if (self.pendingRecovery !== undefined || self.recoveryPending) {
        self.needsNextAuthoritativePass = true;
        self.setPhase('Dirty');
        return;
      }
      self.refreshRealtimeAvailability();
      if (self.realtimeAvailability !== 'ready') {
        self.setPhase('Degraded');
        return;
      }
      const cover = self.source.cover({ epoch: snapshot.epoch, sequence: snapshot.sequence }, snapshot.kind, snapshot.lossBarrier);
      if (cover.status === 'insufficient') {
        return yield* Effect.fail(new RecoveryPassFailure(
          { message: cover.reason, unrecoverable: false, epochMismatch: true },
          new Error('cover-insufficient'),
        ));
      }
      const covered = self.resolveCoveredDrops(snapshot.dropBarrier);
      if (self.lastSnapshotState !== undefined) self.lastSnapshotState = { ...self.lastSnapshotState, coveredDrops: covered };
      self.completeRecoverySuccess(snapshot);
    });
  }

  /**
   * R4-02: only the authoritative watermark is recorded here. The retry budget,
   * active request and transport ACK cover are all deferred until the whole pass
   * (snapshot + reconciliation batch) succeeds.
   */
  private noteAuthoritativeSnapshot(snapshot: RecoverySnapshot): void {
    this.authoritativeWatermark = { epoch: snapshot.epoch, sequence: snapshot.sequence };
    this.lastRecoveredAt = this.retention.now();
  }

  /**
   * R4-02: the pass succeeded. Only now may the transport safe watermark be
   * signed, the retry budget reset, the active request cleared and the runtime
   * become Healthy (or Degraded when the realtime transport is unavailable).
   */
  private completeRecoverySuccess(snapshot: RecoverySnapshot): void {
    const watermark: CommandCursor = { epoch: snapshot.epoch, sequence: snapshot.sequence };
    this.attempts = 0;
    this.lastError = undefined;
    this.activeRecoveryRequest = undefined;
    this.needsNextAuthoritativePass = false;
    this.compensationAttempts = 0;
    this.compensationNoProgressRounds = 0;
    this.compensationBaseline = undefined;
    this.recoveryCursor = watermark;
    this.refreshRealtimeAvailability();
    if (this.recoveryAvailable && this.realtimeAvailability === 'ready' && this.connectionStatus === 'open') {
      this.setPhase('Healthy');
    } else {
      this.setPhase('Degraded');
      this.recordDiagnostic('realtime-unavailable', 'recovery converged but the realtime transport is unavailable; phase Degraded');
    }
    this.recordDiagnostic(
      'recovered',
      snapshot.epoch + ':' + snapshot.sequence + ' (' + snapshot.kind + ', dropBarrier=' + snapshot.dropBarrier +
        ', applied=' + snapshot.appliedRecords + ')',
    );
  }

  /** R4-02: classify the post-snapshot batch; undefined means every command converged. */
  private batchFailure(results: readonly ReconciliationResult[]): string | undefined {
    for (const result of results) {
      if (this.isTerminalCommand(result.commandId)) continue;
      if (result.status === 'failed' || result.status === 'timed-out' || result.status === 'cancelled' || result.status === 'not-found') {
        return 'reconciliation batch could not converge command ' + result.commandId + ' (' + result.status + ')';
      }
      if (result.status === 'dropped' && !this.pendingDrops.some((drop) => drop.commandId === result.commandId)) {
        return 'reconciliation batch dropped command ' + result.commandId + ' without a recovery intent';
      }
    }
    return undefined;
  }

  /**
   * R3-08: converge tracked active commands through the one scheduler in bounded
   * batches sized by the remaining scheduler queue capacity, so the recovery pass
   * itself never overflows the queue and never loops the same 128 commands.
   * Commands with pending drop intents are reconciled first (priority).
   */
  private reconcileActiveBatchEffect(generation: number): Effect.Effect<readonly ReconciliationResult[], RecoveryPassFailure> {
    const self = this;
    return Effect.gen(function* () {
      const pending = self.prioritizedActiveCommandIds();
      const results: ReconciliationResult[] = [];
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
        const chunkResults = yield* self.awaitSchedulerBatch(chunk);
        results.push(...chunkResults);
      }
      return results;
    });
  }

  /**
   * Await one scheduler batch chunk and return the per-command results. R4-02:
   * the old code discarded the per-command outcome and treated a rejected HTTP
   * request as a completed batch; the caller now validates every result.
   * Interruption cancels this recovery's waiter; shared callers keep their work.
   */
  private awaitSchedulerBatch(chunk: readonly string[]): Effect.Effect<readonly ReconciliationResult[], RecoveryPassFailure> {
    const self = this;
    return Effect.tryPromise({
      try: (signal) => new Promise<readonly ReconciliationResult[]>((resolve, reject) => {
        let settled = false;
        const finish = (settle: () => void): void => {
          if (settled) return;
          settled = true;
          settle();
        };
        signal.addEventListener('abort', () => finish(() => reject(new Error('recovery batch wait aborted'))), { once: true });
        void self.scheduler.scheduleMany(chunk, { signal }).then(
          (value) => finish(() => resolve(value)),
          (cause) => finish(() => reject(cause)),
        );
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
    const current = { coveredDrops: this.coveredDropsTotal, sequence: this.authoritativeWatermark?.sequence };
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
      this.needsNextAuthoritativePass = true;
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
    if (this.isTerminalCommand(commandId)) return undefined;
    return {
      workflow,
      isCurrent: () => !this.disposed && this.workflows.get(commandId) === workflow,
    };
  }

  private isTerminalCommand(commandId: string): boolean {
    const projection = this.workflows.get(commandId)?.projection;
    return isTerminalOutcome(projection?.outcome) || projection?.recoveryDisposition === 'expired-unresolved';
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
    if (this.isTerminalCommand(commandId)) {
      if (!this.resolvedAt.has(commandId)) this.resolvedAt.set(commandId, now);
    } else if (this.resolvedAt.has(commandId)) {
      this.resolvedAt.delete(commandId);
    }
    this.enforceTerminalLimit();
    this.scheduleSweep();
  }

  private enforceTerminalLimit(): void {
    if (this.resolvedAt.size <= this.retention.maxResolvedWorkflows) return;
    const ordered = [...this.resolvedAt.entries()].sort((left, right) => left[1] - right[1]);
    const excess = this.resolvedAt.size - this.retention.maxResolvedWorkflows;
    for (let index = 0; index < excess && index < ordered.length; index += 1) this.evictWorkflow(ordered[index][0]);
  }

  private scheduleSweep(): void {
    if (this.disposed || this.resolvedAt.size === 0 || this.retention.resolvedWorkflowTtlMs === 0) {
      this.clearSweepTimer();
      return;
    }
    if (this.sweepTimer !== undefined) return;
    const now = this.retention.now();
    const nextExpiry = Math.min(...[...this.resolvedAt.values()].map((at) => at + this.retention.resolvedWorkflowTtlMs));
    const delay = Math.max(1, Math.min(this.retention.sweepIntervalMs, nextExpiry - now));
    this.sweepTimer = setTimeout(() => {
      this.sweepTimer = undefined;
      this.sweep();
    }, delay);
  }

  private sweep(): void {
    if (this.disposed || !this.started) return;
    const now = this.retention.now();
    if (this.retention.resolvedWorkflowTtlMs > 0) {
      for (const [commandId, resolvedAt] of [...this.resolvedAt]) {
        if (now - resolvedAt >= this.retention.resolvedWorkflowTtlMs) this.evictWorkflow(commandId);
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
    this.resolvedAt.delete(commandId);
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

/**
 * R4-02: scheduler statuses that mean a still-active command did not converge and
 * must fail a recovery pass (bounded retry), never complete as Healthy.
 */
function isReconciliationFailure(status: ReconciliationResultStatus): boolean {
  return status === 'failed' || status === 'timed-out' || status === 'cancelled' || status === 'not-found';
}

/**
 * R4-03: outcomes that prove an authoritative record was applied or was already
 * covered by a newer applied revision. Only these count as appliedRecords and
 * only these may leave the recovery queue.
 */
function isAuthoritativeApplyOutcome(outcome: string): boolean {
  return outcome === 'applied' || outcome === 'stale-covered' || outcome === 'duplicate-applied';
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
function validateRecoveryList(list: CommandRecoveryList, siteId: string, fabId: string): string | undefined {
  if (typeof list.epoch !== 'string' || list.epoch.length === 0) return 'recovery list epoch is not a non-empty string';
  if (!isAuthoritativeSequence(list.latestSequence)) return 'recovery list latestSequence is not a finite non-negative integer';
  const seen = new Set<string>();
  const outcomes: ReadonlySet<string> = new Set(['accepted', 'executing', 'succeeded', 'failed', 'cancelled']);
  for (const record of list.commands) {
    if (record.siteId !== siteId) return 'recovery list contains a foreign site record';
    if (record.fabId !== fabId) {
      return 'recovery list contains a foreign FAB record: ' + String(record.fabId) + ' != ' + fabId;
    }
    if (typeof record.commandId !== 'string' || record.commandId.length === 0 || seen.has(record.commandId)) return 'recovery list contains invalid or duplicate command identity';
    seen.add(record.commandId);
    if (!isAuthoritativeSequence(record.revision)) return 'recovery list record revision is not a finite non-negative integer';
    if (!outcomes.has(record.outcome) || typeof record.terminal !== 'boolean' || record.terminal !== isTerminalOutcome(record.outcome)) return 'recovery list has inconsistent outcome and terminal status';
  }
  return undefined;
}
