/**
 * Runtime contract for the Phase D durable command recovery surface (ADR-008 2.2):
 *
 *  - `GET /api/v1/sites/{siteId}/fabs/{fabId}/commands?status=&afterRevision=` — authoritative
 *    command listing for browser refresh / severe-gap resync (epoch + latestSequence included).
 *  - `GET /api/v1/sites/{siteId}/fabs/{fabId}/command-journal?epoch=&afterSequence=&limit=` — durable
 *    journal replay page with explicit gap information. `epoch` is mandatory (ADR-010 3); a stale
 *    epoch is a 409 `journal-epoch-mismatch` that forces authoritative reconciliation.
 *  - `event: dirty` SSE control frame (no id line, not journaled) — the retained journal may be
 *    incomplete (retention trim / epoch replacement / store fault); the client must reconcile
 *    authoritative command state instead of guessing.
 *
 * Wire field names and shapes come from contracts/json-schema/contracts.schema.json via
 * tools/generate_contracts.py (@/generated/contracts.generated). These Effect schemas validate the
 * payloads without coercion; a malformed backend payload raises instead of becoming a fabricated
 * value. The types are asserted against the generated DTOs in the companion test.
 */
import { Schema } from 'effect';
import { nonEmptyString, nonNegativeInteger, offsetDateTime } from '@/api/primitives.schema';
import type { CommandOutcome } from '@/contracts/command-events.contract';
import type {
  CommandDirtyDto,
  CommandJournalEventDto,
  CommandJournalPageDto,
  CommandRecoveryDto,
  CommandRecoveryListDto,
  JournalEpochMismatchDto,
} from '@/generated/contracts.generated';

/** Outcomes the command protocol may carry; the development backend emits accepted/executing/succeeded. */
export const COMMAND_RECOVERY_OUTCOMES = [
  'accepted',
  'executing',
  'succeeded',
  'failed',
  'cancelled',
] as const satisfies readonly CommandOutcome[];

/** Status filters accepted by the authoritative listing endpoint (ADR-008 2.2). */
export const COMMAND_STATUS_FILTERS = ['active', 'terminal', 'all'] as const;
/** Journal page bounds enforced by ApiHost/EquipmentCommandService. */
export const DEFAULT_COMMAND_JOURNAL_LIMIT = 100;
export const MAX_COMMAND_JOURNAL_LIMIT = 1000;
/**
 * Server-classified dirty causes. `retention-trim` and `epoch-replaced` mean events may be
 * missing; `store-fault` means the durable journal can no longer be trusted at all.
 */
export const COMMAND_DIRTY_REASONS = ['retention-trim', 'epoch-replaced', 'store-fault'] as const;
/** ProblemDetails code returned by the journal endpoint for a missing/invalid epoch or cursor. */
export const JOURNAL_CURSOR_INVALID_CODE = 'journal-cursor-invalid' as const;
/** HTTP 409 code returned when the requested journal epoch is no longer current. */
export const JOURNAL_EPOCH_MISMATCH_CODE = 'journal-epoch-mismatch' as const;

const commandOutcomeSchema = Schema.Literals(COMMAND_RECOVERY_OUTCOMES);
const commandStatusFilterSchema = Schema.Literals(COMMAND_STATUS_FILTERS);
const commandDirtyReasonSchema = Schema.Literals(COMMAND_DIRTY_REASONS);
const journalLimitSchema = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: MAX_COMMAND_JOURNAL_LIMIT }),
);

/** One authoritative command recovery record (CommandRecoveryDto). */
export const commandRecoverySchema = Schema.Struct({
  siteId: nonEmptyString,
  fabId: nonEmptyString,
  commandId: nonEmptyString,
  revision: nonNegativeInteger,
  outcome: commandOutcomeSchema,
  occurredAt: offsetDateTime,
  terminal: Schema.Boolean,
});

/** Authoritative FAB-scoped command listing (CommandRecoveryListDto). */
export const commandRecoveryListSchema = Schema.Struct({
  epoch: nonEmptyString,
  latestSequence: nonNegativeInteger,
  commands: Schema.Array(commandRecoverySchema).pipe(Schema.mutable),
});

/** One durable journal event (CommandJournalEventDto). */
export const commandJournalEventSchema = Schema.Struct({
  sequence: nonNegativeInteger,
  fabId: nonEmptyString,
  commandId: nonEmptyString,
  revision: nonNegativeInteger,
  outcome: commandOutcomeSchema,
  occurredAt: offsetDateTime,
});

/** Journal replay page including explicit gap information (CommandJournalPageDto). */
export const commandJournalPageSchema = Schema.Struct({
  epoch: nonEmptyString,
  hasGap: Schema.Boolean,
  firstRetainedSequence: nonNegativeInteger,
  latestSequence: nonNegativeInteger,
  nextAfterSequence: nonNegativeInteger,
  events: Schema.Array(commandJournalEventSchema).pipe(Schema.mutable),
});

/**
 * HTTP 409 application/problem+json body: the requested epoch is stale. The client must fall back
 * to the authoritative command listing (epoch + latestSequence) instead of continuing by sequence.
 */
export const journalEpochMismatchSchema = Schema.Struct({
  code: Schema.Literals([JOURNAL_EPOCH_MISMATCH_CODE]),
  currentEpoch: nonEmptyString,
  firstRetainedSequence: nonNegativeInteger,
  latestSequence: nonNegativeInteger,
});

/** SSE `event: dirty` control frame payload (CommandDirtyDto). */
export const commandDirtySchema = Schema.Struct({
  reason: commandDirtyReasonSchema,
  droppedCount: nonNegativeInteger,
  epoch: nonEmptyString,
  sequence: nonNegativeInteger,
  occurredAt: offsetDateTime,
});

/** Query parameters of the authoritative listing endpoint (status default all, afterRevision default -1). */
export const commandListQuerySchema = Schema.Struct({
  status: Schema.optional(commandStatusFilterSchema),
  afterRevision: Schema.optional(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(-1)),
  ),
});

/**
 * Query parameters of the journal page endpoint (ADR-010 3): epoch is mandatory; afterSequence is
 * exclusive and defaults to 0; limit defaults to 100 with a 1..1000 bound.
 */
export const commandJournalQuerySchema = Schema.Struct({
  epoch: nonEmptyString,
  afterSequence: Schema.optional(nonNegativeInteger),
  limit: Schema.optional(journalLimitSchema),
});

export type CommandStatusFilter = typeof commandStatusFilterSchema.Type;
export type CommandDirtyReason = typeof commandDirtyReasonSchema.Type;
export type CommandRecovery = typeof commandRecoverySchema.Type;
export type CommandRecoveryList = typeof commandRecoveryListSchema.Type;
export type CommandJournalEvent = typeof commandJournalEventSchema.Type;
export type CommandJournalPage = typeof commandJournalPageSchema.Type;
export type CommandDirty = typeof commandDirtySchema.Type;
export type JournalEpochMismatch = typeof journalEpochMismatchSchema.Type;
export type CommandListQuery = typeof commandListQuerySchema.Type;
export type CommandJournalQuery = typeof commandJournalQuerySchema.Type;

export const decodeCommandRecoveryList = Schema.decodeUnknownEffect(commandRecoveryListSchema);
export const decodeCommandJournalEvent = Schema.decodeUnknownEffect(commandJournalEventSchema);
export const decodeCommandJournalPage = Schema.decodeUnknownEffect(commandJournalPageSchema);
export const decodeCommandDirty = Schema.decodeUnknownEffect(commandDirtySchema);
export const decodeJournalEpochMismatch = Schema.decodeUnknownEffect(journalEpochMismatchSchema);

/**
 * Compile-time bridge to the generated wire contracts: this only type-checks when the decoded
 * schema types are structurally assignable to the DTOs generated from the JSON Schema.
 */
export type CommandRecoveryListWireAligned = CommandRecoveryList extends Omit<CommandRecoveryListDto, 'commands'>
  ? CommandRecoveryList['commands'][number] extends CommandRecoveryDto
    ? true
    : never
  : never;
export type CommandJournalPageWireAligned = CommandJournalPage extends Omit<CommandJournalPageDto, 'events'>
  ? CommandJournalPage['events'][number] extends CommandJournalEventDto
    ? true
    : never
  : never;
export type CommandDirtyWireAligned = CommandDirty extends CommandDirtyDto ? true : never;
export type JournalEpochMismatchWireAligned = JournalEpochMismatch extends JournalEpochMismatchDto ? true : never;