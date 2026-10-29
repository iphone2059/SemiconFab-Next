import { Effect } from 'effect';
import type { CommandResultEvent } from '@/contracts/command-events.contract';
import type {
  CommandGateway,
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
  /**
   * Approved Effect execution boundary supplied by the composition root
   * (AppRuntime.runPromise). The API layer never calls the global Effect runner.
   */
  readonly runPromise: <A, E>(effect: Effect.Effect<A, E, never>) => Promise<A>;
}

/** Browser implementation of the authoritative command-recovery contract (ADR-008 §2.4). */
export interface HttpCommandGateway extends CommandGateway {}

export function createHttpCommandGateway(options: HttpCommandGatewayOptions): HttpCommandGateway {
  const baseUrl = options.baseUrl ?? '/api/v1';
  const transport = createHttpTransport({ fetchImpl: options.fetchImpl });
  const run = options.runPromise;

  const getCommandStatus = (fabId: string, commandId: string): Promise<CommandResultEvent | null> =>
    run(
      Effect.gen(function* () {
        const body = yield* transport.fetchJson(baseUrl + '/commands/' + encodeURIComponent(commandId));
        const parsed = yield* decodeApiResponse(submittedEquipmentCommandSchema, 'invalid command response')(body);
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
      }).pipe(
        Effect.catchTag('HttpFailure', (error) => (error.status === 404 ? Effect.succeed(null) : Effect.fail(error))),
      ),
    );

  const listFabCommands = (
    siteId: string,
    fabId: string,
    filter: CommandRecoveryFilter,
  ): Promise<CommandRecoveryList> =>
    run(
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
    cursor: CommandJournalQuery = {},
  ): Promise<CommandJournalPage> =>
    run(
      Effect.gen(function* () {
        const search = new URLSearchParams();
        if (cursor.afterSequence !== undefined) search.set('afterSequence', `${cursor.afterSequence}`);
        if (cursor.limit !== undefined) {
          const limit = Math.min(Math.max(Math.trunc(cursor.limit), 1), MAX_COMMAND_JOURNAL_LIMIT);
          search.set('limit', `${limit}`);
        } else {
          search.set('limit', `${DEFAULT_COMMAND_JOURNAL_LIMIT}`);
        }
        const path = baseUrl +
          '/sites/' + encodeURIComponent(siteId) +
          '/fabs/' + encodeURIComponent(fabId) +
          '/command-journal?' + search.toString();
        const body = yield* transport.fetchJson(path);
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
        } satisfies CommandJournalPage;
      }),
    );

  return { getCommandStatus, listFabCommands, getCommandJournalPage };
}

export type HttpCommandGatewayError = ApiError;
