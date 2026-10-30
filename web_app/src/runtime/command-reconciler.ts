import { Effect } from 'effect';
import type { CommandGateway, CommandGatewayError } from '@/contracts/command-gateway.contract';
import type { CommandWorkflow } from '@/contracts/command-workflow.contract';
import type { CommandResultEvent } from '@/contracts/command-events.contract';

/**
 * Identity of one authoritative reconciliation request (ADR-011 §2.2). The
 * scheduler entry id is the request generation: when a newer entry supersedes the
 * request (or the FAB/entry was disposed), a late result must not write the actor.
 */
export interface ReconciliationRequestIdentity {
  readonly fabId: string;
  readonly commandId: string;
  /** Monotonic scheduler entry id; unique per scheduled request. */
  readonly entryId: number;
}

/** Guard evaluated immediately before the result is applied to the actor. */
export type ReconciliationCurrentGuard = (identity: ReconciliationRequestIdentity) => boolean;

export interface ReconciliationRequest {
  /** Scheduler entry generation this request belongs to. */
  readonly entryId: number;
  /** True only while the workflow + scheduler entry generation are still current. */
  readonly isCurrent: ReconciliationCurrentGuard;
  readonly apply: (event: CommandResultEvent) => boolean;
}

/**
 * Authoritative reconciliation: ask the backend for the command's current status
 * and feed one result into the workflow. This is the convergence path after a
 * disconnect or a missed WebSocket frame; the runtime decides when to call it.
 *
 * `reconcile` returns a native Effect (ADR-011 §2.1): the caller owns timeout,
 * interruption and the physical request budget, and interruption aborts the
 * underlying fetch. The result is applied only after `isCurrent` re-validated the
 * workflow and the scheduler entry generation (stale results never write).
 */
export class CommandReconciler {
  constructor(private readonly gateway: CommandGateway) {}

  reconcile(
    _workflow: CommandWorkflow,
    fabId: string,
    commandId: string,
    request: ReconciliationRequest,
  ): Effect.Effect<boolean, CommandGatewayError> {
    const identity: ReconciliationRequestIdentity = { fabId, commandId, entryId: request.entryId };
    return this.gateway.getCommandStatus(fabId, commandId).pipe(
      Effect.flatMap((event) =>
        Effect.sync(() => {
          if (!event) return false;
          // ADR-011 §2.2: validate workflow identity AND the scheduler entry
          // generation before mutating the actor; a timed-out/superseded request
          // must never publish its late authoritative result.
          if (!request.isCurrent(identity)) return false;
          if (event.fabId !== fabId || event.commandId !== commandId || !Number.isInteger(event.revision) || event.revision < 0) return false;
          return request.apply(event);
        })),
    );
  }
}
