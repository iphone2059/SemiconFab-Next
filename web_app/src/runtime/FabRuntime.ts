import type { CommandEventSource } from '../application/contracts/CommandEvents';
import type { CommandGateway } from '../application/contracts/CommandGateway';
import type { CommandWorkflow, CommandWorkflowProjection, CommandWorkflowRegistry } from '../application/contracts/CommandWorkflow';
import { CommandEventBridge } from '../application/coordination/CommandEventBridge';
import { CommandReconciler } from './commands/CommandReconciler';
import { XStateCommandWorkflowAdapter } from './commands/XStateCommandWorkflowAdapter';

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
  private started = false;

  constructor(options: FabRuntimeOptions) {
    this.fabId = options.fabId;
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
    if (this.started) return;
    this.bridge.start();
    this.started = true;
  }

  stop(): void {
    if (!this.started) return;
    this.bridge.stop();
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
    return workflow;
  }

  getWorkflow(commandId: string): CommandWorkflow | undefined {
    return this.workflows.get(commandId);
  }

  /** Converge one command with the backend after a disconnect/missed frame. */
  async reconcileCommand(commandId: string): Promise<boolean> {
    const workflow = this.workflows.get(commandId);
    if (!workflow || !this.reconciler) return false;
    const reconciled = await this.reconciler.reconcile(workflow, this.fabId, commandId);
    if (reconciled) this.notify();
    return reconciled;
  }

  dispose(): void {
    this.stop();
    for (const workflow of this.workflows.values()) workflow.dispose();
    this.workflows.clear();
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
