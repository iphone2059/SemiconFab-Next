import type { CommandEventSource } from '../application/contracts/CommandEvents';
import type { CommandGateway } from '../application/contracts/CommandGateway';
import type { CommandWorkflow, CommandWorkflowProjection, CommandWorkflowRegistry } from '../application/contracts/CommandWorkflow';
import { CommandEventBridge } from '../application/coordination/CommandEventBridge';
import { CommandReconciler } from './commands/CommandReconciler';
import { XStateCommandWorkflowAdapter } from './commands/XStateCommandWorkflowAdapter';
import type { Subscription } from 'rxjs';

export type CommandWorkflowFactory = (fabId: string, commandId: string) => CommandWorkflow;

export interface FabRuntimeOptions {
  readonly fabId: string;
  readonly source: CommandEventSource;
  readonly gateway?: CommandGateway;
  /** Test seam; production defaults to XStateCommandWorkflowAdapter. */
  readonly createWorkflow?: CommandWorkflowFactory;
}

/**
 * Per-FAB assembly layer: the only place that wires the realtime source, the
 * application CommandEventBridge and the workflow implementations together
 * (ARCH-09). One runtime exists per FAB; all command identities stay scoped to
 * (fabId, commandId).
 */
export class FabRuntime {
  readonly fabId: string;
  private readonly workflows = new Map<string, CommandWorkflow>();
  private readonly listeners = new Set<() => void>();
  private readonly bridge: CommandEventBridge;
  private readonly reconciler?: CommandReconciler;
  private readonly createWorkflow: CommandWorkflowFactory;
  private readonly source: CommandEventSource;
  private readonly reconciliations = new Map<string, Promise<boolean>>();
  private reconnectSubscription?: Subscription;
  private disposed = false;
  private started = false;

  constructor(options: FabRuntimeOptions) {
    this.fabId = options.fabId;
    this.source = options.source;
    this.reconciler = options.gateway ? new CommandReconciler(options.gateway) : undefined;
    this.createWorkflow = options.createWorkflow ?? ((fabId, commandId) => new XStateCommandWorkflowAdapter(fabId, commandId, this.reconciler));
    const registry: CommandWorkflowRegistry = {
      get: (fabId, commandId) => (fabId === this.fabId ? this.workflows.get(commandId) : undefined),
    };
    this.bridge = new CommandEventBridge(options.source, registry, {
      fabId: options.fabId,
      onResultDelivered: () => { this.notify(); },
    });
  }

  start(): void {
    if (this.started || this.disposed) return;
    this.bridge.start();
    this.started = true;
    this.reconnectSubscription = this.source.reconnected$?.subscribe(() => this.reconcileActive());
    this.reconcileActive();
  }

  stop(): void {
    if (!this.started) return;
    this.bridge.stop();
    this.reconnectSubscription?.unsubscribe();
    this.reconnectSubscription = undefined;
    this.started = false;
  }

  /** Create the workflow for a submitted command; replays results held before registration. */
  trackCommand(commandId: string): CommandWorkflow {
    const existing = this.workflows.get(commandId);
    if (existing) return existing;
    const workflow = this.createWorkflow(this.fabId, commandId);
    this.workflows.set(commandId, workflow);
    this.bridge.flushRecovery();
    this.notify();
    if (!workflow.projection || workflow.projection.revision < 0) void this.reconcileCommand(commandId);
    return workflow;
  }

  getWorkflow(commandId: string): CommandWorkflow | undefined {
    return this.workflows.get(commandId);
  }

  /** Converge one command with the backend after a disconnect/missed frame. */
  reconcileCommand(commandId: string): Promise<boolean> {
    const workflow = this.workflows.get(commandId);
    if (!workflow || !this.reconciler || this.disposed) return Promise.resolve(false);
    const pending = this.reconciliations.get(commandId);
    if (pending) return pending;
    const isCurrent = () => !this.disposed && this.workflows.get(commandId) === workflow;
    const request = this.reconciler.reconcile(workflow, this.fabId, commandId, isCurrent)
      .then(reconciled => { if (reconciled && isCurrent()) this.notify(); return reconciled; })
      // Recovery runs in the background. Keep failures contained and retry on
      // the next connection restoration or explicit reconciliation.
      .catch(() => false)
      .finally(() => { if (this.reconciliations.get(commandId) === request) this.reconciliations.delete(commandId); });
    this.reconciliations.set(commandId, request);
    return request;
  }

  private reconcileActive(): void {
    for (const [commandId, workflow] of this.workflows) {
      const outcome = workflow.projection?.outcome;
      if (outcome !== 'succeeded' && outcome !== 'failed' && outcome !== 'cancelled') void this.reconcileCommand(commandId);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    for (const workflow of this.workflows.values()) workflow.dispose();
    this.workflows.clear();
    this.reconciliations.clear();
    this.listeners.clear();
    this.bridge.dispose();
  }

  /** UI projection subscription: read-only, never writes workflow state. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  getProjection(commandId: string): CommandWorkflowProjection | undefined {
    return this.workflows.get(commandId)?.projection;
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  get workflowCount(): number {
    return this.workflows.size;
  }

  get pendingCount(): number {
    return this.bridge.pendingCount;
  }

  get running(): boolean {
    return this.started;
  }
}
