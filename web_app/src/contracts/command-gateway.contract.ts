import type { Effect } from 'effect';
import type { CommandOutcome, CommandResultEvent } from '@/contracts/command-events.contract';

/**
 * Authoritative command-recovery contract (ADR-008 §2.2/§2.4, ADR-010, ADR-011).
 * The backend is the only durable authority: a browser refresh or a transport gap
 * can always list the FAB's unconfirmed commands and page the journal from an
 * epoch-scoped cursor, so the frontend never has to invent recovery from an
 * in-memory ledger.
 *
 * Every gateway method returns a native Effect (ADR-011 §2.1): the scheduler wraps
 * it in `Effect.timeoutOption`, so a timeout/dispose interrupts the fiber and the
 * AbortSignal reaches the underlying fetch. Implementations must never call
 * `AppRuntime.runPromise` internally.
 */
export type CommandRecoveryFilter = 'active' | 'terminal' | 'all';

/** One persisted authoritative command record. */
export interface CommandRecoveryRecord {
  readonly siteId: string;
  readonly fabId: string;
  readonly commandId: string;
  /** Backend-monotonic revision; never decreases for one command. */
  readonly revision: number;
  readonly outcome: CommandOutcome;
  readonly occurredAt: string;
  /** Terminal records are retained only inside the backend retention window. */
  readonly terminal: boolean;
}

/** GET /api/v1/sites/{siteId}/fabs/{fabId}/commands?status=active|terminal|all */
export interface CommandRecoveryList {
  /** Journal epoch scoping the cursor; a changed epoch invalidates old cursors. */
  readonly epoch: string;
  readonly latestSequence: number;
  readonly commands: readonly CommandRecoveryRecord[];
}

/**
 * GET /api/v1/sites/{siteId}/fabs/{fabId}/command-journal cursor (ADR-010 §3).
 * The cursor is always epoch-scoped and sequence-explicit: an epoch mismatch is a
 * 409 `journal-epoch-mismatch`, never a silent guess from a bare sequence.
 */
export interface CommandJournalQuery {
  /** Journal epoch the cursor belongs to; always sent as `?epoch=`. */
  readonly epoch: string;
  /** Last delivered sequence; the returned page starts strictly after it. */
  readonly afterSequence: number;
  readonly limit?: number;
}

/** One journal frame (ADR-008 CommandJournalEventDto). */
export interface CommandJournalEvent {
  readonly sequence: number;
  readonly fabId: string;
  readonly commandId: string;
  readonly revision: number;
  readonly outcome: CommandOutcome;
  readonly occurredAt: string;
}

/** GET /api/v1/sites/{siteId}/fabs/{fabId}/command-journal page. */
export interface CommandJournalPage {
  readonly epoch: string;
  /** True when the requested cursor was pruned/from another epoch: reconciliation is required. */
  readonly hasGap: boolean;
  readonly firstRetainedSequence: number;
  readonly latestSequence: number;
  readonly events: readonly CommandJournalEvent[];
  /**
   * Next page cursor: the last returned sequence, or the requested cursor on an
   * empty page (ADR-010 §3). Recovery loops until `nextAfterSequence >= latestSequence`.
   */
  readonly nextAfterSequence: number;
}

/**
 * The request was cancelled (timeout/dispose/caller abort). Cancellation is NOT a
 * business failure: it must never enter failure counters or store-fault
 * diagnostics, and it is the only error a cancelled physical request produces.
 */
export interface CommandRequestAborted {
  readonly _tag: 'CommandRequestAborted';
  readonly message: string;
  readonly cause?: unknown;
}

/**
 * The journal cursor's epoch was replaced/pruned (HTTP 409
 * `journal-epoch-mismatch`). The consumer must fall back to authoritative list
 * recovery instead of continuing to page by sequence (ADR-010 §3).
 */
export interface CommandJournalEpochMismatch {
  readonly _tag: 'CommandJournalEpochMismatch';
  readonly message: string;
  /** Epoch the backend currently serves; cursors from any other epoch are invalid. */
  readonly currentEpoch: string;
  readonly firstRetainedSequence: number;
  readonly latestSequence: number;
}

/**
 * Retryable authoritative-query failure: network/transport, HTTP 5xx or 429.
 * The recovery state machine keeps Dirty and retries with bounded backoff.
 */
export interface CommandGatewayRetryableFailure {
  readonly _tag: 'CommandGatewayRetryableFailure';
  readonly message: string;
  /** HTTP status when the failure came from a response; absent for network failures. */
  readonly status?: number;
  readonly cause?: unknown;
}

/** Non-retryable authoritative-query failure classification. */
export type CommandGatewayTerminalReason =
  | 'invalid-response'
  | 'identity-mismatch'
  | 'rejected'
  | 'invalid-request'
  | 'store-fault';

/**
 * Non-retryable authoritative-query failure. `store-fault` means the durable
 * journal can no longer be trusted at all (immediate Unrecoverable); the other
 * reasons are deterministic client/contract failures (no retry can fix them).
 */
export interface CommandGatewayTerminalFailure {
  readonly _tag: 'CommandGatewayTerminalFailure';
  readonly reason: CommandGatewayTerminalReason;
  readonly message: string;
  readonly status?: number;
  readonly cause?: unknown;
}

/** Closed error algebra of the authoritative command gateway. */
export type CommandGatewayError =
  | CommandRequestAborted
  | CommandJournalEpochMismatch
  | CommandGatewayRetryableFailure
  | CommandGatewayTerminalFailure;

/**
 * Authoritative command gateway used for recovery after missed realtime frames.
 * A missing command inside the retention window is represented explicitly
 * (null / 404 semantics), never as a fabricated command outcome.
 */
export interface CommandGateway {
  /** GET /api/v1/commands/{commandId}; null inside the documented 404 window. */
  getCommandStatus(fabId: string, commandId: string): Effect.Effect<CommandResultEvent | null, CommandGatewayError>;
  /** List the FAB's commands by terminal state; the browser-refresh recovery entry. */
  listFabCommands(siteId: string, fabId: string, filter: CommandRecoveryFilter): Effect.Effect<CommandRecoveryList, CommandGatewayError>;
  /** Page the authoritative journal from an epoch cursor; hasGap requires list recovery. */
  getCommandJournalPage(siteId: string, fabId: string, query: CommandJournalQuery): Effect.Effect<CommandJournalPage, CommandGatewayError>;
}
