import type { CommandEventSource } from '../application/contracts/CommandEvents';
import type { CommandGateway } from '../application/contracts/CommandGateway';
import type { CommandWorkflow, CommandWorkflowProjection, CommandWorkflowRegistry } from '../application/contracts/CommandWorkflow';
import { CommandCorrelationRegistry } from '../application/coordination/CommandCorrelationRegistry';
import { CommandEventBridge } from '../application/coordination/CommandEventBridge';
import { CommandReconciler } from './commands/CommandReconciler';
import { XStateCommandWorkflowAdapter } from './commands/XStateCommandWorkflowAdapter';
import type { Subscription } from 'rxjs';

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
  readonly fabId: string;
  readonly source: CommandEventSource;
  readonly gateway?: CommandGateway;
  /** Test seam; production defaults to XStateCommandWorkflowAdapter. */
  readonly createWorkflow?: CommandWorkflowFactory;
  /** Test seam for retention bounds/clock; production keeps the defaults. */
  readonly retention?: FabRuntimeRetentionOptions;
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

const TERMINAL_OUTCOMES = new Set(['succeeded', 'failed', 'cancelled']);

/**
 * Per-FAB assembly layer: the only place that wires the realtime source, the
 * application CommandEventBridge and the workflow implementations together
 * (ARCH-09). One runtime exists per FAB; all command identities stay scoped to
 * (fabId, commandId).
 *
 * Lifecycle: realtime gaps/reconnects schedule one coalesced authoritative
 * reconciliation pass over tracked active commands. Workflows are bounded:
 * active commands are always retained, terminal ones are evicted by TTL/max
 * (their actor and subscriptions are disposed) while a recent read-only
 * projection stays available to the UI.
 */
export class FabRuntime {
  readonly fabId: string;
  private readonly workflows = new Map<string, CommandWorkflow>();
  private readonly terminalAt = new Map<string, number>();
  private readonly retainedProjections = new Map<string, CommandWorkflowProjection>();
  private readonly listeners = new Set<() => void>();
  private readonly bridge: CommandEventBridge;
  private readonly correlation: CommandCorrelationRegistry;
  private readonly reconciler?: CommandReconciler;
  private readonly createWorkflow: CommandWorkflowFactory;
  private readonly source: CommandEventSource;
  private readonly retention: ResolvedRetention;
  private readonly reconciliations = new Map<string, Promise<boolean>>();
  private reconnectSubscription?: Subscription;
  private gapSubscription?: Subscription;
  private sweepTimer?: ReturnType<typeof setTimeout>;
  private reconcileScheduled = false;
  private gapObserved = false;
  private disposed = false;
  private started = false;

  constructor(options: FabRuntimeOptions) {
    this.fabId = options.fabId;
    this.source = options.source;
    this.retention = resolveRetention(options.retention);
    this.reconciler = options.gateway ? new CommandReconciler(options.gateway) : undefined;
    this.createWorkflow = options.createWorkflow ?? ((fabId, commandId) => new XStateCommandWorkflowAdapter(fabId, commandId, this.reconciler));
    this.correlation = new CommandCorrelationRegistry({
      maxTerminalEntries: this.retention.maxTerminalWorkflows,
      terminalTtlMs: this.retention.terminalTtlMs,
      now: this.retention.now,
    });
    const registry: CommandWorkflowRegistry = {
      get: (fabId, commandId) => (fabId === this.fabId ? this.workflows.get(commandId) : undefined),
    };
    this.bridge = new CommandEventBridge(options.source, registry, {
      fabId: options.fabId,
      correlation: this.correlation,
      onResultDelivered: () => { this.afterDelivery(); },
    });
  }

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    // Signal subscriptions exist before the bridge can consume the stream: a
    // synchronous replay-gap frame must never be missed.
    // A restored stream may have missed results; reconcile authoritative state.
    // Signals are coalesced into one pass per tick and are dispose-safe.
    this.gapSubscription = this.source.gaps$?.subscribe(() => {
      this.gapObserved = true;
      this.scheduleReconcilePass();
    });
    this.reconnectSubscription = this.source.reconnected$?.subscribe(() => this.scheduleReconcilePass());
    this.bridge.start();
    this.reconcileActive();
    this.scheduleSweep();
  }

  stop(): void {
    if (!this.started) return;
    this.bridge.stop();
    this.gapSubscription?.unsubscribe();
    this.gapSubscription = undefined;
    this.reconnectSubscription?.unsubscribe();
    this.reconnectSubscription = undefined;
    this.clearSweepTimer();
    this.started = false;
  }

  /** Create the workflow for a submitted command; replays results held before registration. */
  trackCommand(commandId: string): CommandWorkflow {
    const existing = this.workflows.get(commandId);
    if (existing) return existing;
    const workflow = this.createWorkflow(this.fabId, commandId);
    this.workflows.set(commandId, workflow);
    this.bridge.flushRecovery();
    this.afterDelivery();
    // A replay gap means the local stream may hold no evidence for this command;
    // converge from the authoritative query instead of trusting local silence.
    const localEvidence = this.hasLocalEvidence(commandId);
    if (this.gapObserved || !localEvidence || !workflow.projection || workflow.projection.revision < 0) {
      void this.reconcileCommand(commandId);
    }
    return workflow;
  }

  getWorkflow(commandId: string): CommandWorkflow | undefined {
    return this.workflows.get(commandId);
  }

  /** True when realtime events (or held recovery events) were observed for the command. */
  hasLocalEvidence(commandId: string): boolean {
    return this.correlation.lastRevision(this.fabId, commandId) !== undefined ||
      this.bridge.recoveryQueue.pendingFor(this.fabId, commandId).length > 0;
  }

  /** Converge one command with the backend after a disconnect/missed frame. */
  reconcileCommand(commandId: string): Promise<boolean> {
    const workflow = this.workflows.get(commandId);
    if (!workflow || !this.reconciler || this.disposed) return Promise.resolve(false);
    if (TERMINAL_OUTCOMES.has(workflow.projection?.outcome ?? '')) return Promise.resolve(false);
    const pending = this.reconciliations.get(commandId);
    if (pending) return pending;
    const isCurrent = () => !this.disposed && this.workflows.get(commandId) === workflow;
    const request = this.reconciler.reconcile(workflow, this.fabId, commandId, isCurrent)
      .then(reconciled => {
        if (reconciled && isCurrent()) { this.afterDelivery(); }
        return reconciled;
      })
      // Recovery runs in the background. Keep failures contained and retry on
      // the next connection restoration or explicit reconciliation.
      .catch(() => false)
      .finally(() => { if (this.reconciliations.get(commandId) === request) this.reconciliations.delete(commandId); });
    this.reconciliations.set(commandId, request);
    return request;
  }

  /**
   * Authoritative reconciliation for every tracked active command. Used after a
   * replay gap/reconnect and available to tests and future recovery UI.
   */
  async reconcileAll(): Promise<number> {
    return this.reconcileTracked(this.workflows.keys());
  }

  /** Reconcile only the given tracked commands; terminal/evicted ids are ignored. */
  async reconcileTracked(commandIds: Iterable<string>): Promise<number> {
    const unique = [...new Set(commandIds)];
    const results = await Promise.all(unique.map((commandId) => {
      const workflow = this.workflows.get(commandId);
      if (!workflow || TERMINAL_OUTCOMES.has(workflow.projection?.outcome ?? '')) return Promise.resolve(false);
      return this.reconcileCommand(commandId);
    }));
    return results.filter(Boolean).length;
  }

  private reconcileActive(): void {
    for (const [commandId, workflow] of this.workflows) {
      const outcome = workflow.projection?.outcome;
      if (!TERMINAL_OUTCOMES.has(outcome ?? '')) void this.reconcileCommand(commandId);
    }
  }

  private scheduleReconcilePass(): void {
    if (this.disposed || !this.started) return;
    // A burst of gap/reconnect signals from the same tick shares one pass; a
    // signal that arrives while the pass is running queues exactly one follow-up.
    if (this.reconcileScheduled) return;
    this.reconcileScheduled = true;
    void Promise.resolve().then(async () => {
      this.reconcileScheduled = false;
      if (!this.started || this.disposed) return;
      await this.reconcileAll();
      if (!this.reconcileScheduled) this.gapObserved = false;
    });
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    this.clearSweepTimer();
    this.reconcileScheduled = false;
    this.gapObserved = false;
    for (const workflow of this.workflows.values()) workflow.dispose();
    this.workflows.clear();
    this.terminalAt.clear();
    this.retainedProjections.clear();
    this.reconciliations.clear();
    this.listeners.clear();
    this.bridge.dispose();
  }

  /** UI projection subscription: read-only, never writes workflow state. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /**
   * Recent read-only projection: live workflows first, then the retained
   * terminal projection of an evicted workflow so the UI row does not vanish.
   */
  getProjection(commandId: string): CommandWorkflowProjection | undefined {
    return this.workflows.get(commandId)?.projection ?? this.retainedProjections.get(commandId);
  }

  get workflowCount(): number {
    return this.workflows.size;
  }

  get terminalWorkflowCount(): number {
    return this.terminalAt.size;
  }

  get retainedProjectionCount(): number {
    return this.retainedProjections.size;
  }

  get pendingCount(): number {
    return this.bridge.pendingCount;
  }

  get running(): boolean {
    return this.started;
  }

  private afterDelivery(): void {
    this.recordTerminals();
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  /** Track terminals, enforce the max cap and (re)schedule the TTL sweep. */
  private recordTerminals(): void {
    if (this.disposed) return;
    const now = this.retention.now();
    for (const [commandId, workflow] of this.workflows) {
      if (TERMINAL_OUTCOMES.has(workflow.projection?.outcome ?? '')) {
        if (!this.terminalAt.has(commandId)) this.terminalAt.set(commandId, now);
      } else if (this.terminalAt.has(commandId)) {
        this.terminalAt.delete(commandId);
      }
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
    if (this.disposed || this.terminalAt.size === 0) { this.clearSweepTimer(); return; }
    if (this.sweepTimer !== undefined) return;
    const now = this.retention.now();
    const nextExpiry = Math.min(...[...this.terminalAt.values()].map((at) => at + this.retention.terminalTtlMs));
    const delay = Math.max(1, Math.min(this.retention.sweepIntervalMs, nextExpiry - now));
    this.sweepTimer = setTimeout(() => { this.sweepTimer = undefined; this.sweep(); }, delay);
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

  private evictWorkflow(commandId: string): void {
    const workflow = this.workflows.get(commandId);
    this.terminalAt.delete(commandId);
    if (!workflow) return;
    const projection = workflow.projection;
    workflow.dispose();
    this.workflows.delete(commandId);
    if (projection) this.rememberProjection(commandId, projection);
    this.notify();
  }

  private rememberProjection(commandId: string, projection: CommandWorkflowProjection): void {
    if (this.retention.maxRetainedProjections === 0) return;
    this.retainedProjections.delete(commandId);
    this.retainedProjections.set(commandId, projection);
    while (this.retainedProjections.size > this.retention.maxRetainedProjections) {
      const oldest = this.retainedProjections.keys().next().value;
      if (oldest === undefined) break;
      this.retainedProjections.delete(oldest);
    }
  }

  private clearSweepTimer(): void {
    if (this.sweepTimer === undefined) return;
    clearTimeout(this.sweepTimer);
    this.sweepTimer = undefined;
  }
}
