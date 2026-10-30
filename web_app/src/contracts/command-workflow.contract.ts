import type { CommandOutcome, CommandResultEvent } from '@/contracts/command-events.contract';

/** Read-only projection of workflow state for UI display; never a second authority. */
export interface CommandWorkflowProjection {
  readonly state: string;
  readonly revision: number;
  readonly outcome: CommandOutcome | 'pending';
  readonly recoveryDisposition: 'tracked' | 'expired-unresolved';
}

/**
 * Public workflow contract. XState (or any other implementation) is injected by
 * the Runtime behind this interface; realtime/application code never imports an
 * actor implementation (ARCH-08).
 *
 * Round 5.1 / P1-03 source isolation: the contract has no source-agnostic
 * `receive`. The *data source* of an event decides which method is used; the
 * call path (direct stream delivery, recovery queue retry, journal replay) never
 * upgrades a realtime event into an authoritative one:
 *
 * - `receiveRealtime`: a frame observed on the live SSE stream. It may NEVER
 *   revive an `expired-unresolved` workflow (regardless of revision) and may
 *   never correct a same-revision outcome conflict.
 * - `receiveAuthoritative`: a validated record from the authoritative List or
 *   Journal snapshot. After identity/revision/outcome validation it may resolve
 *   `expired-unresolved` and correct a wrong local projection (including a
 *   terminal one), but it may never roll the revision back.
 *
 * `markExpiredUnresolved` is the Recovery-only transition: an authoritative
 * snapshot proved the command absent while it was still locally active.
 */
export interface CommandWorkflow {
  /** Apply one live realtime result (never restores expired, never corrects conflicts). */
  receiveRealtime(event: CommandResultEvent): void;
  /** Apply one validated authoritative List/Journal record (may resolve expired and correct projections). */
  receiveAuthoritative(event: CommandResultEvent): void;
  markExpiredUnresolved(): void;
  reconcile(commandId: string): Promise<void>;
  dispose(): void;
  /** Optional read-only projection; the UI must not write it back. */
  readonly projection?: CommandWorkflowProjection;
}

export interface CommandWorkflowRegistry {
  get(fabId: string, commandId: string): CommandWorkflow | undefined;
}
