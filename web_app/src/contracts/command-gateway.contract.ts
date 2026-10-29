import type { CommandOutcome, CommandResultEvent } from '@/contracts/command-events.contract';

/**
 * Authoritative command-recovery contract (ADR-008 §2.2/§2.4). The backend is the
 * only durable authority: a browser refresh or a transport gap can always list
 * the FAB's unconfirmed commands and page the journal from a cursor, so the
 * frontend never has to invent recovery from an in-memory ledger.
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

/** GET /api/v1/sites/{siteId}/fabs/{fabId}/command-journal cursor. */
export interface CommandJournalQuery {
  readonly epoch?: string;
  readonly afterSequence?: number;
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
}

/**
 * Authoritative command gateway used for recovery after missed realtime frames.
 * Implementations reject on transport/schema failure; a missing command inside
 * the retention window is represented explicitly (null / 404 semantics), never
 * as a fabricated command outcome.
 */
export interface CommandGateway {
  /** GET /api/v1/commands/{commandId}; null inside the documented 404 window. */
  getCommandStatus(fabId: string, commandId: string): Promise<CommandResultEvent | null>;
  /** List the FAB's commands by terminal state; the browser-refresh recovery entry. */
  listFabCommands(siteId: string, fabId: string, filter: CommandRecoveryFilter): Promise<CommandRecoveryList>;
  /** Page the authoritative journal from a cursor; hasGap requires list recovery. */
  getCommandJournalPage(siteId: string, fabId: string, cursor: CommandJournalQuery): Promise<CommandJournalPage>;
}
