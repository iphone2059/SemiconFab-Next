import { Effect, Option } from 'effect';
import type { CommandResultEvent } from '@/contracts/command-events.contract';
import { commandIdentityMatches, submittedEquipmentCommandSchema } from '@/api/command.schema';
import { createHttpTransport, decodeApiResponse, CommandIdentityMismatch, type ApiError, type FetchLike } from '@/api/http.transport';
export interface HttpCommandGatewayOptions { readonly baseUrl?: string; readonly fetchImpl?: FetchLike; }
export interface HttpCommandGateway {
  getCommandStatus(fabId: string, commandId: string): Effect.Effect<Option.Option<CommandResultEvent>, ApiError>;
}
export function createHttpCommandGateway(options: HttpCommandGatewayOptions = {}): HttpCommandGateway {
  const baseUrl = options.baseUrl ?? '/api/v1';
  const transport = createHttpTransport({ fetchImpl: options.fetchImpl });
  return {
    getCommandStatus: (fabId, commandId) => Effect.gen(function*() {
      const body = yield* transport.fetchJson(baseUrl + '/commands/' + encodeURIComponent(commandId));
      const parsed = yield* decodeApiResponse(submittedEquipmentCommandSchema, 'invalid command response')(body);
      const fields = [];
      if (!commandIdentityMatches(fabId, parsed.fabId)) fields.push('fabId');
      if (!commandIdentityMatches(commandId, parsed.commandId)) fields.push('commandId');
      if (fields.length) return yield* Effect.fail(new CommandIdentityMismatch(fields));
      return Option.some({ fabId: parsed.fabId, commandId: parsed.commandId,
        revision: parsed.revision, outcome: parsed.outcome, occurredAt: parsed.occurredAt });
    }).pipe(Effect.catchTag('HttpFailure', error => error.status === 404 ? Effect.succeed(Option.none()) : Effect.fail(error))),
  };
}
