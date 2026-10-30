import type * as Fiber from 'effect/Fiber';
import type { Scope } from 'effect';
import { runCommandStream, stopCommandStream } from '@/runtime/command-stream';
import type { RuntimeHost } from '@/runtime/fab-runtime-host';
import type { CommandEventSource, CommandResultEvent } from '@/contracts/command-events.contract';
import type { Effect } from 'effect';
import type { CommandGateway, CommandGatewayError } from '@/contracts/command-gateway.contract';
import type { CommandWorkflow, CommandWorkflowRegistry } from '@/contracts/command-workflow.contract';
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
  /** Called when a workflow rejects an observed revision and authoritative recovery must retry it. */
  readonly onRejected?: (event: CommandResultEvent) => void;
  /** Called when the scoped stream consumer exits while the bridge is still started. */
  readonly onStreamExit?: () => void;
  /** Approved Effect execution boundary (AppRuntime satisfies it structurally). */
  readonly runtime: RuntimeHost;
  /** CommandTransportScope: the only owner of the command-result consumer fiber. */
  readonly scope: Scope.Scope;
}

/**
 * Application-layer coordinator: subscribes to the realtime typed stream, filters
 * by FAB, de-dupes by revision and delivers results to the workflow registry. It
 * knows neither WebSocket nor XState; the Runtime assembles all three (ADR-0010,
 * ARCH-07/09). Missing workflows are not dropped: the result is held for a retry
 * pass or backend reconciliation.
 *
 * The consumer fiber is forked into the supplied CommandTransportScope, not the
 * global Effect runtime (ADR-007 §2).
 */
export class CommandEventBridge {
  private commandFiber?: Fiber.Fiber<void, never>;
  private readonly correlation: CommandCorrelationRegistry;
  private readonly recovery: CommandEventRecovery;
  private started = false;

  constructor(
    private readonly source: CommandEventSource,
    private readonly workflows: CommandWorkflowRegistry,
    private readonly options: CommandEventBridgeOptions,
  ) {
    this.correlation = options.correlation ?? new CommandCorrelationRegistry();
    this.recovery = options.recovery ?? new CommandEventRecovery();
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.commandFiber = runCommandStream(
      this.options.runtime,
      this.options.scope,
      this.source.commandResults,
      (event) => {
        if (this.started) this.receive(event);
      },
      () => {
        if (!this.started) return;
        this.started = false;
        this.commandFiber = undefined;
        this.options.onStreamExit?.();
      },
    );
  }

  stop(): void {
    this.started = false;
    const fiber = this.commandFiber;
    this.commandFiber = undefined;
    if (fiber) stopCommandStream(this.options.runtime, fiber);
  }

  /** Visible for tests and Runtime-driven injection of a single decoded frame. */
  receive(event: CommandResultEvent): void {
    if (this.options.fabId && event.fabId !== this.options.fabId) return;
    if (this.correlation.observe(event) !== 'new') return;
    this.deliver(event);
  }

  receiveAuthoritative(event: CommandResultEvent): 'applied' | 'unverifiable' | 'held' | 'rejected' | 'already-applied' | 'ignored' {
    if (this.options.fabId && event.fabId !== this.options.fabId) return 'ignored';
    if (this.correlation.isApplied(event)) {
      this.recovery.remove(event);
      return 'already-applied';
    }
    this.correlation.observe(event);
    const workflow = this.workflows.get(event.fabId, event.commandId);
    if (!workflow) {
      const retained = this.recovery.hold(event);
      this.options.onUncorrelated?.(event);
      if (!retained) this.options.onRejected?.(event);
      return retained ? 'held' : 'rejected';
    }
    const result = this.applyToWorkflow(workflow, event);
    if (result === 'applied') this.recovery.remove(event);
    if (result === 'rejected') {
      this.recovery.hold(event);
      this.options.onRejected?.(event);
    }
    return result;
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
      const result = this.applyToWorkflow(workflow, event);
      if (result === 'applied') delivered += 1;
      if (result === 'rejected') {
        this.recovery.hold(event);
        this.options.onRejected?.(event);
      }
    }
    return delivered;
  }

  /**
   * Reconcile one command through the authoritative backend gateway, then retry.
   * Test/contract helper only: production reconciliation is the scheduler's job
   * (ADR-011 §2.2); the caller supplies the approved Effect runner.
   */
  async reconcile(
    gateway: CommandGateway,
    fabId: string,
    commandId: string,
    run: (effect: Effect.Effect<CommandResultEvent | null, CommandGatewayError>) => Promise<CommandResultEvent | null>,
  ): Promise<number> {
    await this.recovery.reconcile(gateway, fabId, commandId, run);
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

  get running(): boolean {
    return this.started;
  }

  /**
   * Apply one event to its workflow, then acknowledge it ONLY after the actor
   * provably advanced to that revision (ADR-010 §6.2). Three states stay separate:
   *  - observed: correlation registry saw the revision (dedupe/ordering only);
   *  - applied: the actor projection advanced to the revision;
   *  - acknowledged: transport ordered-ledger entry marked applied, which may still
   *    be blocked behind an earlier pending entry until its own prefix is safe.
   * Stale/terminal/duplicate revisions are observed but never acknowledged; a
   * workflow that exposes no projection cannot prove application, so it is
   * delivered (tests/custom adapters) but never acknowledged.
   * Returns whether the event was delivered to the actor.
   */
  private applyToWorkflow(
    workflow: CommandWorkflow,
    event: CommandResultEvent,
  ): 'applied' | 'unverifiable' | 'rejected' {
    const before = workflow.projection?.revision;
    workflow.receive(event);
    const after = workflow.projection?.revision;
    const verifiable = before !== undefined || after !== undefined;
    const applied = verifiable && (after ?? -1) >= event.revision;
    if (verifiable && !applied) return 'rejected';
    this.options.onResultDelivered?.(event);
    if (!applied) return 'unverifiable';
    this.correlation.markApplied(event);
    this.source.acknowledge(event);
    return 'applied';
  }

  private deliver(event: CommandResultEvent): void {
    const workflow = this.workflows.get(event.fabId, event.commandId);
    if (workflow) {
      if (this.applyToWorkflow(workflow, event) === 'rejected') {
        this.recovery.hold(event);
        this.options.onRejected?.(event);
      }
      return;
    }
    this.recovery.hold(event);
    this.options.onUncorrelated?.(event);
  }
}
