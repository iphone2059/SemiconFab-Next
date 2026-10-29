import { runCommandStream } from '@/runtime/command-stream';
import type { CommandEventSource, CommandResultEvent } from '@/contracts/command-events.contract';
import type { CommandGateway } from '@/contracts/command-gateway.contract';
import type { CommandWorkflowRegistry } from '@/contracts/command-workflow.contract';
import { CommandCorrelationRegistry } from '@/runtime/command-correlation-registry';
import { CommandEventRecovery } from '@/runtime/command-event-recovery';

export interface CommandEventBridgeOptions {
  /** When set, only events for this FAB are considered (per-FAB runtime); the key remains (fabId, commandId). */
  readonly fabId?: string;
  readonly recovery?: CommandEventRecovery;
  readonly correlation?: CommandCorrelationRegistry;
  /** Called when a result has no workflow yet; the event is also held in the bounded recovery queue. */
  readonly onUncorrelated?: (event: CommandResultEvent) => void;
  /** Called after a result is delivered to a workflow (used by Runtime projections). */
  readonly onResultDelivered?: (event: CommandResultEvent) => void;
}

/**
 * Application-layer coordinator: subscribes to the realtime typed stream, filters
 * by FAB, de-dupes by revision and delivers results to the workflow registry. It
 * knows neither WebSocket nor XState; the Runtime assembles all three (ADR-0010,
 * ARCH-07/09). Missing workflows are not dropped: the result is held for a retry
 * pass or backend reconciliation.
 */
export class CommandEventBridge {
  private stopCommandStream?: () => void;
  private readonly correlation: CommandCorrelationRegistry;
  private readonly recovery: CommandEventRecovery;
  private started = false;

  constructor(
    private readonly source: CommandEventSource,
    private readonly workflows: CommandWorkflowRegistry,
    private readonly options: CommandEventBridgeOptions = {},
  ) {
    this.correlation = options.correlation ?? new CommandCorrelationRegistry();
    this.recovery = options.recovery ?? new CommandEventRecovery();
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopCommandStream = runCommandStream(this.source.commandResults, (event) => this.receive(event));
  }

  stop(): void {
    this.stopCommandStream?.();
    this.stopCommandStream = undefined;
    this.started = false;
  }

  /** Visible for tests and Runtime-driven injection of a single decoded frame. */
  receive(event: CommandResultEvent): void {
    if (this.options.fabId && event.fabId !== this.options.fabId) return;
    if (this.correlation.observe(event) !== 'new') return;
    this.deliver(event);
  }

  /**
   * Retry pending results after a workflow is registered (for example when the
   * HTTP submit response finally creates the actor). Returns the number of
   * results delivered in this pass; still-uncorrelated events stay queued.
   */
  flushRecovery(): number {
    let delivered = 0;
    for (const event of this.recovery.drain()) {
      const workflow = this.workflows.get(event.fabId, event.commandId);
      if (!workflow) {
        this.recovery.hold(event);
        continue;
      }
      workflow.receive(event);
      this.options.onResultDelivered?.(event);
      delivered += 1;
    }
    return delivered;
  }

  /** Reconcile one command through the authoritative backend gateway, then retry. */
  async reconcile(gateway: CommandGateway, fabId: string, commandId: string): Promise<number> {
    await this.recovery.reconcile(gateway, fabId, commandId);
    return this.flushRecovery();
  }

  dispose(): void {
    this.stop();
    this.recovery.dispose();
    this.correlation.clear();
  }

  get pendingCount(): number {
    return this.recovery.size;
  }

  get correlationRegistry(): CommandCorrelationRegistry {
    return this.correlation;
  }

  get recoveryQueue(): CommandEventRecovery {
    return this.recovery;
  }

  private deliver(event: CommandResultEvent): void {
    const workflow = this.workflows.get(event.fabId, event.commandId);
    if (workflow) {
      workflow.receive(event);
      this.options.onResultDelivered?.(event);
      return;
    }
    this.recovery.hold(event);
    this.options.onUncorrelated?.(event);
  }
}
