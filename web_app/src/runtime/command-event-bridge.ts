import type * as Fiber from 'effect/Fiber';
import type { Effect, Exit, Scope } from 'effect';
import { runCommandStream, stopCommandStream } from '@/runtime/command-stream';
import type { RuntimeHost } from '@/runtime/fab-runtime-host';
import type { CommandEventSource, CommandResultEvent } from '@/contracts/command-events.contract';
import type { CommandGateway, CommandGatewayError } from '@/contracts/command-gateway.contract';
import type { CommandWorkflow, CommandWorkflowRegistry } from '@/contracts/command-workflow.contract';
import { CommandCorrelationRegistry } from '@/runtime/command-correlation-registry';
import { CommandEventRecovery } from '@/runtime/command-event-recovery';

/**
 * Explicit outcome of offering one result to the workflow layer (R4-03). The old
 * void return made "already applied", "held for a missing workflow" and "rejected
 * by the actor projection" indistinguishable to the runtime.
 *
 * Round 5.1 / P1-02 adds `conflict`: the realtime stream delivered a revision
 * whose outcome disagrees with the recorded outcome for that revision. A conflict
 * is never acknowledged and never applied; only an authoritative observation may
 * resolve/correct it.
 */
export type CommandDeliveryOutcome =
  | 'applied'
  | 'held'
  | 'duplicate-applied'
  | 'stale-covered'
  | 'rejected'
  | 'conflict'
  | 'ignored';

/** Counts of one retry pass over the bounded recovery queue. */
export interface CommandFlushResult {
  readonly applied: number;
  readonly held: number;
  readonly rejected: number;
}

/** Which contract method delivered the event: the source decides the channel, never the retry path. */
type CommandDeliveryChannel = 'realtime' | 'authoritative';

export interface CommandEventBridgeOptions {
  /** When set, only events for this FAB are considered (per-FAB runtime); the key remains (fabId, commandId). */
  readonly fabId?: string;
  readonly recovery?: CommandEventRecovery;
  readonly correlation?: CommandCorrelationRegistry;
  /** Called when a result has no workflow yet; the event is also held in the bounded recovery queue. */
  readonly onUncorrelated?: (event: CommandResultEvent) => void;
  /** Called after a result is delivered to a workflow (used by Runtime projections). */
  readonly onResultDelivered?: (event: CommandResultEvent) => void;
  /**
   * Round 5.1 / P1-02: a realtime revision arrived with a different outcome than
   * the one already recorded for that revision. The event is held as an
   * unresolved conflict (never ACKed, never applied); the owner must converge
   * authoritatively. FabRuntime maps this to Dirty + list-only recovery.
   */
  readonly onConflict?: (event: CommandResultEvent) => void;
  /**
   * R4-03: a retried event was rejected by the actor projection. It stays held
   * (bounded by the existing queue) and is reported so FabRuntime can enter Dirty
   * and converge authoritatively instead of silently dropping the revision.
   */
  readonly onRejected?: (event: CommandResultEvent) => void;
  /** R4-05b: bounded consumer defect callback (a handler threw); never swallowed. */
  readonly onDefect?: (cause: unknown) => void;
  /**
   * R4-05: the command-result consumer fiber terminated unexpectedly. The bridge
   * has already reset started/commandFiber before this callback runs, so the owner
   * can restart the consumer without ever observing a dead-but-started bridge.
   * stop()/dispose() are expected exits and never invoke it.
   */
  readonly onConsumerExit?: (exit: Exit.Exit<void, never>) => void;
  /** Approved Effect execution boundary (AppRuntime satisfies it structurally). */
  readonly runtime: RuntimeHost;
  /** CommandTransportScope: the only owner of the command-result consumer fiber. */
  readonly scope: Scope.Scope;
}


const CONSUMER_LABEL = 'command-event-bridge';

/**
 * Application-layer coordinator: subscribes to the realtime typed stream, filters
 * by FAB, de-dupes by revision and delivers results to the workflow registry. It
 * knows neither WebSocket nor XState; the Runtime assembles all three (ADR-0010,
 * ARCH-07/09). Missing workflows are not dropped: the result is held for a retry
 * pass or backend reconciliation.
 *
 * R4-03: observed and applied state are separate. The realtime path dedupes on the
 * observed watermark, while receiveAuthoritative() bypasses that gate for an
 * authoritative List/Journal snapshot and re-delivers to the actor. Only a
 * projection that provably advanced calls correlation.markApplied().
 *
 * Round 5.1 / P1-02: a same-revision outcome conflict is reported as `conflict`
 * / onConflict, recorded in the bounded recovery queue (never ACKed, never
 * applied) and resolved only when an authoritative observation covers the
 * revision. The data source — not the call path — selects receiveRealtime vs
 * receiveAuthoritative; flushRecovery() always retries queued SSE events as
 * realtime and can never upgrade them.
 *
 * R4-05: the consumer fiber is forked into the supplied CommandTransportScope and
 * observed through runCommandStream's observer: handler defects are reported
 * (bounded onDefect), and an unexpected fiber exit resets started/commandFiber
 * before onConsumerExit so the owner can restart it.
 *
 * The consumer fiber is forked into the supplied CommandTransportScope, not the
 * global Effect runtime (ADR-007 §2).
 */
export class CommandEventBridge {
  private commandFiber?: Fiber.Fiber<void, never>;
  private readonly correlation: CommandCorrelationRegistry;
  private readonly recovery: CommandEventRecovery;
  private started = false;
  /** Expected exit flag: set only by stop()/dispose() around the controlled interrupt. */
  private expectedExit = false;
  private disposedState = false;

  constructor(
    private readonly source: CommandEventSource,
    private readonly workflows: CommandWorkflowRegistry,
    private readonly options: CommandEventBridgeOptions,
  ) {
    this.correlation = options.correlation ?? new CommandCorrelationRegistry();
    this.recovery = options.recovery ?? new CommandEventRecovery();
  }

  start(): void {
    if (this.started || this.disposedState) return;
    this.started = true;
    this.expectedExit = false;
    this.commandFiber = runCommandStream(
      this.options.runtime,
      this.options.scope,
      this.source.commandResults,
      (event) => {
        if (this.started) this.receive(event);
      },
      {
        label: CONSUMER_LABEL,
        onDefect: (_label, cause) => {
          this.options.onDefect?.(cause);
        },
        onExit: (_label, exit) => {
          this.handleConsumerExit(exit);
        },
      },
    );
  }

  /** Re-arm the consumer after an unexpected exit; a no-op while already running. */
  restart(): void {
    this.start();
  }

  stop(): void {
    this.started = false;
    const fiber = this.commandFiber;
    this.commandFiber = undefined;
    if (!fiber) return;
    this.expectedExit = true;
    try {
      stopCommandStream(this.options.runtime, fiber);
    } finally {
      // onExit runs synchronously inside stopCommandStream; clear defensively so a
      // late exit can never be mistaken for an expected one.
      this.expectedExit = false;
    }
  }

  /**
   * The owned consumer fiber terminated. Expected exits (stop/dispose) are silent;
   * an unexpected exit resets started/commandFiber first, then reports so the
   * runtime can schedule a bounded restart (R4-05).
   */
  private handleConsumerExit(exit: Exit.Exit<void, never>): void {
    this.commandFiber = undefined;
    if (this.expectedExit) {
      this.expectedExit = false;
      return;
    }
    this.started = false;
    if (!this.disposedState) this.options.onConsumerExit?.(exit);
  }

  /**
   * Realtime delivery path. De-dupes on the observed revision and returns an
   * explicit outcome: delivered to the actor => applied/rejected, missing workflow
   * => held, duplicate => duplicate-applied/rejected, older => stale-covered, and
   * a same-revision outcome disagreement => conflict (never acknowledged, never
   * applied; it is recorded for authoritative resolution).
   */
  receive(event: CommandResultEvent): CommandDeliveryOutcome {
    if (this.isForeign(event)) return 'ignored';
    const decision = this.correlation.observe(event);
    if (decision === 'conflict') {
      // Round 5.1 / P1-02: the outcome invariant for this revision is violated on
      // the wire. Do NOT ACK (even if appliedRevision >= revision), do NOT apply,
      // do NOT overwrite the recorded observation: only authority may resolve it.
      this.recovery.holdConflict(event);
      this.options.onConflict?.(event);
      return 'conflict';
    }
    if (decision === 'duplicate' || decision === 'stale') {
      const applied = this.correlation.lastAppliedRevision(event.fabId, event.commandId);
      if (applied !== undefined && applied >= event.revision) {
        this.source.acknowledge(event);
        if (this.correlation.hasUnappliedObservation(event.fabId, event.commandId)) {
          this.options.onRejected?.(event);
        }
        return decision === 'duplicate' ? 'duplicate-applied' : 'stale-covered';
      }
    }
    const workflow = this.workflows.get(event.fabId, event.commandId);
    if (!workflow) {
      this.holdUncorrelated(event);
      return 'held';
    }
    const outcome = this.applyToWorkflow(workflow, event, 'realtime');
    if (outcome === 'rejected') {
      this.recovery.hold(event);
      this.options.onRejected?.(event);
    } else if (this.correlation.hasUnappliedObservation(event.fabId, event.commandId)) {
      this.options.onRejected?.(event);
    }
    return outcome;
  }

  /**
   * Authoritative delivery path (R4-03): a List/Journal snapshot is fresh authority,
   * so the observed-revision duplicate gate must never block it. The recorded
   * outcome may be corrected/resolved here (observeAuthoritative) and the actor is
   * re-delivered with receiveAuthoritative; the outcome is classified from the
   * actor projection (afterRevision >= revision => applied/stale-covered, otherwise
   * rejected). A workflow that exposes no projection cannot prove application.
   */
  receiveAuthoritative(event: CommandResultEvent, _coveredRevision?: number): CommandDeliveryOutcome {
    if (this.isForeign(event)) return 'ignored';
    // Record/repair the observation without ever regressing the observed watermark.
    // The duplicate/stale decision never blocks authoritative re-application: a
    // same-revision correction must reach the actor so the projection converges.
    this.correlation.observeAuthoritative(event);
    const workflow = this.workflows.get(event.fabId, event.commandId);
    if (!workflow) {
      // Authoritative records are held exactly once (no onUncorrelated duplicate
      // signal: authority already knows this command, it merely needs its actor).
      this.recovery.hold(event);
      return 'held';
    }
    const outcome = this.applyToWorkflow(workflow, event, 'authoritative');
    if (outcome === 'applied' || outcome === 'stale-covered') {
      // Round 5.1 / P1-02: the authoritative revision is applied/covered, so every
      // recorded conflict at or below it is resolved.
      this.recovery.resolveAuthoritative(event);
    }
    if (outcome === 'rejected') {
      this.recovery.hold(event);
      this.options.onRejected?.(event);
    } else if (this.correlation.hasUnappliedObservation(event.fabId, event.commandId)) {
      this.options.onRejected?.(event);
    }
    return outcome;
  }

  /**
   * Retry pending results after a workflow is registered (for example when the
   * HTTP submit response finally creates the actor) or after an authoritative
   * snapshot. R4-03: this is a snapshot + selective release, never a drain-and-drop:
   * events leave the queue only when applied/covered; rejected events are re-held
   * and reported through onRejected; still-uncorrelated events stay held.
   *
   * Round 5.1 / P1-03 source isolation: the queue only ever holds events that
   * arrived through the realtime source, so a retry pass always uses
   * receiveRealtime(); it can never upgrade a queued SSE event into authority.
   * Conflict records are not part of the snapshot and are never applied here.
   */
  flushRecovery(): CommandFlushResult {
    let applied = 0;
    let held = 0;
    let rejected = 0;
    for (const event of this.recovery.snapshot()) {
      if (this.isForeign(event)) {
        this.recovery.release(event);
        continue;
      }
      const workflow = this.workflows.get(event.fabId, event.commandId);
      if (!workflow) {
        held += 1;
        continue;
      }
      const outcome = this.applyToWorkflow(workflow, event, 'realtime');
      if (outcome === 'applied' || outcome === 'stale-covered') {
        this.recovery.release(event);
        applied += 1;
        continue;
      }
      rejected += 1;
      this.options.onRejected?.(event);
    }
    return { applied, held, rejected };
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
    return this.flushRecovery().applied;
  }

  dispose(): void {
    this.disposedState = true;
    this.stop();
    this.recovery.dispose();
    this.correlation.clear();
  }

  /** Held realtime events plus unresolved conflict records (never Healthy while > 0). */
  get pendingCount(): number {
    return this.recovery.size;
  }

  /** Unresolved same-revision outcome conflicts (Round 5.1 / P1-02). */
  get conflictCount(): number {
    return this.recovery.conflictCount;
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

  private isForeign(event: CommandResultEvent): boolean {
    return this.options.fabId !== undefined && event.fabId !== this.options.fabId;
  }

  private holdUncorrelated(event: CommandResultEvent): void {
    this.recovery.hold(event);
    this.options.onUncorrelated?.(event);
  }

  /**
   * Apply one event through the source-selected workflow contract, then
   * acknowledge it ONLY after the actor provably advanced to that revision
   * (ADR-010 §6.2). Three states stay separate:
   *  - observed: correlation registry saw the revision (dedupe/ordering only);
   *  - applied: the actor projection advanced to the revision and markApplied ran;
   *  - acknowledged: transport ordered-ledger entry marked applied, which may still
   *    be blocked behind an earlier pending entry until its own prefix is safe.
   * A verifiable workflow that does not advance rejects the event (terminal/stale):
   * observed but never applied/acked. A workflow that exposes no projection cannot
   * prove application.
   *
   * Round 5.1 / P1-03: the channel is decided by the event's data source only —
   * a queued/retried realtime event can never be delivered as authoritative.
   */
  private applyToWorkflow(
    workflow: CommandWorkflow,
    event: CommandResultEvent,
    channel: CommandDeliveryChannel,
  ): CommandDeliveryOutcome {
    const before = workflow.projection?.revision;
    if (channel === 'authoritative') workflow.receiveAuthoritative(event);
    else workflow.receiveRealtime(event);
    const projection = workflow.projection;
    const after = projection?.revision;
    const verifiable = before !== undefined || after !== undefined;
    if (verifiable) {
      if ((after ?? -1) < event.revision) return 'rejected';
      if (after === event.revision && projection?.outcome !== event.outcome) return 'rejected';
      // R4-03: the applied watermark may only advance after the projection proved
      // it advanced; markApplied itself refuses an outcome-disagreeing event.
      this.correlation.markApplied(event);
      this.options.onResultDelivered?.(event);
      this.source.acknowledge(event);
      return (before ?? -1) >= event.revision ? 'stale-covered' : 'applied';
    }
    // No projection means application cannot be proven.
    return 'rejected';
  }
}
