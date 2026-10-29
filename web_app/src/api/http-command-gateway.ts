import { Effect, Option } from 'effect';
import type { CommandResultEvent } from '@/contracts/command-events.contract';
import type {
  CommandGateway,
  CommandGatewayError,
  CommandJournalPage,
  CommandJournalQuery,
  CommandRecoveryFilter,
  CommandRecoveryList,
} from '@/contracts/command-gateway.contract';
import { commandIdentityMatches, submittedEquipmentCommandSchema } from '@/api/command.schema';
import {
  DEFAULT_COMMAND_JOURNAL_LIMIT,
  MAX_COMMAND_JOURNAL_LIMIT,
  decodeCommandJournalPage,
  decodeCommandRecoveryList,
  decodeJournalEpochMismatch,
} from '@/api/command-recovery.schema';
import {
  CommandIdentityMismatch,
  InvalidServerResponse,
  createHttpTransport,
  decodeApiResponse,
  type ApiError,
  type FetchLike,
} from '@/api/http.transport';

export interface HttpCommandGatewayOptions {
  readonly baseUrl?: string;
  readonly fetchImpl?: FetchLike;
}

/** Browser implementation of the authoritative command-recovery contract (ADR-008 §2.4, ADR-011 §2.1). */
export interface HttpCommandGateway extends CommandGateway {}

export type HttpCommandGatewayError = CommandGatewayError;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** ProblemDetails store fault is the only HTTP failure that is immediately unrecoverable (ADR-010 §4). */
const isStoreFault = (body: unknown): boolean =>
  isRecord(body) && (body.code === 'store-fault' || body.code === 'STORE_FAULT');

/**
 * Maps the transport error algebra onto the gateway's closed error algebra so the
 * recovery state machine can decide retry / Unrecoverable / list-fallback without
 * inspecting HTTP internals.
 */
function gatewayFailure(error: ApiError): CommandGatewayError {
  switch (error._tag) {
    case 'RequestAborted':
      return { _tag: 'CommandRequestAborted', message: error.message, cause: error.cause };
    case 'NetworkUnavailable':
      return { _tag: 'CommandGatewayRetryableFailure', message: error.message, cause: error.cause };
    case 'IdempotencyConflict':
    case 'HttpFailure':
      if (isStoreFault(error.body)) {
        return { _tag: 'CommandGatewayTerminalFailure', reason: 'store-fault', message: error.message, status: error.status };
      }
      if (error.status >= 500 || error.status === 429) {
        return { _tag: 'CommandGatewayRetryableFailure', message: error.message, status: error.status };
      }
      // F3: a missing/invalid journal cursor is a deterministic client/contract
      // error (400 journal-cursor-invalid), never retried by sequence.
      return {
        _tag: 'CommandGatewayTerminalFailure',
        reason: error.status === 400 ? 'invalid-request' : 'rejected',
        message: error.message,
        status: error.status,
      };
    case 'InvalidServerResponse':
      return { _tag: 'CommandGatewayTerminalFailure', reason: 'invalid-response', message: error.message, cause: error.cause };
    case 'CommandIdentityMismatch':
      return { _tag: 'CommandGatewayTerminalFailure', reason: 'identity-mismatch', message: error.message };
    case 'InvalidRequest':
      return { _tag: 'CommandGatewayTerminalFailure', reason: 'invalid-request', message: error.message, cause: error.cause };
  }
}

const isCommandGatewayFailure = (error: ApiError | CommandGatewayError): error is CommandGatewayError => {
  switch (error._tag) {
    case 'CommandRequestAborted':
    case 'CommandJournalEpochMismatch':
    case 'CommandGatewayRetryableFailure':
    case 'CommandGatewayTerminalFailure':
      return true;
    default:
      return false;
  }
};

const asCommandGateway = <A>(effect: Effect.Effect<A, ApiError | CommandGatewayError>): Effect.Effect<A, CommandGatewayError> =>
  effect.pipe(Effect.catch((error) => Effect.fail(isCommandGatewayFailure(error) ? error : gatewayFailure(error))));

/**
 * Decodes the F3 409 journal ProblemDetails body (`journal-epoch-mismatch`) into the
 * structured gateway error; any other 409 stays a terminal rejected failure.
 */
function epochMismatchFailure(
  error: { readonly message: string; readonly body?: unknown },
): Effect.Effect<never, CommandGatewayError> {
  const decoded = decodeJournalEpochMismatch(error.body).pipe(
    Effect.mapError((): CommandGatewayError => ({
      _tag: 'CommandGatewayTerminalFailure',
      reason: 'rejected',
      message: error.message,
      status: 409,
    })),
  );
  return decoded.pipe(
    Effect.flatMap((mismatch): Effect.Effect<never, CommandGatewayError> => Effect.fail({
      _tag: 'CommandJournalEpochMismatch',
      message: error.message,
      currentEpoch: mismatch.currentEpoch,
      firstRetainedSequence: mismatch.firstRetainedSequence,
      latestSequence: mismatch.latestSequence,
    })),
  );
}

export function createHttpCommandGateway(options: HttpCommandGatewayOptions = {}): HttpCommandGateway {
  const baseUrl = options.baseUrl ?? '/api/v1';
  const transport = createHttpTransport({ fetchImpl: options.fetchImpl });

  const getCommandStatus = (fabId: string, commandId: string): Effect.Effect<CommandResultEvent | null, CommandGatewayError> =>
    asCommandGateway(
      Effect.gen(function* () {
        const bodyOption = yield* transport
          .fetchJson(baseUrl + '/commands/' + encodeURIComponent(commandId))
          .pipe(
            Effect.map((body) => Option.some(body)),
            Effect.catchTag('HttpFailure', (error) =>
              error.status === 404 ? Effect.succeed(Option.none<unknown>()) : Effect.fail(error)),
          );
        if (Option.isNone(bodyOption)) return null;
        const parsed = yield* decodeApiResponse(submittedEquipmentCommandSchema, 'invalid command response')(bodyOption.value);
        const fields: string[] = [];
        if (!commandIdentityMatches(fabId, parsed.fabId)) fields.push('fabId');
        if (!commandIdentityMatches(commandId, parsed.commandId)) fields.push('commandId');
        if (fields.length > 0) return yield* Effect.fail(new CommandIdentityMismatch(fields));
        return {
          fabId: parsed.fabId,
          commandId: parsed.commandId,
          revision: parsed.revision,
          outcome: parsed.outcome,
          occurredAt: parsed.occurredAt,
        } satisfies CommandResultEvent;
      }),
    );

  const listFabCommands = (
    siteId: string,
    fabId: string,
    filter: CommandRecoveryFilter,
  ): Effect.Effect<CommandRecoveryList, CommandGatewayError> =>
    asCommandGateway(
      Effect.gen(function* () {
        const path = baseUrl +
          '/sites/' + encodeURIComponent(siteId) +
          '/fabs/' + encodeURIComponent(fabId) +
          '/commands?status=' + encodeURIComponent(filter);
        const body = yield* transport.fetchJson(path);
        const parsed = yield* decodeCommandRecoveryList(body).pipe(
          Effect.mapError((cause) => new InvalidServerResponse('invalid command recovery list: ' + cause.message, cause)),
        );
        const fields: string[] = [];
        for (const record of parsed.commands) {
          if (!commandIdentityMatches(fabId, record.fabId)) fields.push('fabId');
          if (!commandIdentityMatches(siteId, record.siteId)) fields.push('siteId');
        }
        if (fields.length > 0) return yield* Effect.fail(new CommandIdentityMismatch([...new Set(fields)]));
        return {
          epoch: parsed.epoch,
          latestSequence: parsed.latestSequence,
          commands: parsed.commands,
        } satisfies CommandRecoveryList;
      }),
    );

  const getCommandJournalPage = (
    siteId: string,
    fabId: string,
    query: CommandJournalQuery,
  ): Effect.Effect<CommandJournalPage, CommandGatewayError> =>
    asCommandGateway(
      Effect.gen(function* () {
        const search = new URLSearchParams();
        search.set('epoch', query.epoch);
        search.set('afterSequence', `${query.afterSequence}`);
        const limit = query.limit === undefined
          ? DEFAULT_COMMAND_JOURNAL_LIMIT
          : Math.min(Math.max(Math.trunc(query.limit), 1), MAX_COMMAND_JOURNAL_LIMIT);
        search.set('limit', `${limit}`);
        const path = baseUrl +
          '/sites/' + encodeURIComponent(siteId) +
          '/fabs/' + encodeURIComponent(fabId) +
          '/command-journal?' + search.toString();
        const body = yield* transport.fetchJson(path).pipe(
          Effect.catch((error: ApiError): Effect.Effect<unknown, CommandGatewayError> =>
            error._tag === 'IdempotencyConflict' ? epochMismatchFailure(error) : Effect.fail(gatewayFailure(error))),
        );
        const parsed = yield* decodeCommandJournalPage(body).pipe(
          Effect.mapError((cause) => new InvalidServerResponse('invalid command journal page: ' + cause.message, cause)),
        );
        if (parsed.events.some((event) => !commandIdentityMatches(fabId, event.fabId))) {
          return yield* Effect.fail(new CommandIdentityMismatch(['fabId']));
        }
        return {
          epoch: parsed.epoch,
          hasGap: parsed.hasGap,
          firstRetainedSequence: parsed.firstRetainedSequence,
          latestSequence: parsed.latestSequence,
          events: parsed.events,
          nextAfterSequence: parsed.nextAfterSequence,
        } satisfies CommandJournalPage;
      }),
    );

  return { getCommandStatus, listFabCommands, getCommandJournalPage };
}
