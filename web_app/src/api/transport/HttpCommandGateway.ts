import type { CommandGateway } from '../../application/contracts/CommandGateway';
import { commandIdentityMatches, submittedEquipmentCommandSchema } from '../schemas/command.schema';
import { createHttpTransport, HttpStatusError, type FetchLike } from './http';

export interface HttpCommandGatewayOptions {
  readonly baseUrl?: string;
  readonly fetchImpl?: FetchLike;
}

/** Single HTTP policy and full command schema for authoritative reconciliation. */
export function createHttpCommandGateway(options: HttpCommandGatewayOptions = {}): CommandGateway {
  const baseUrl = options.baseUrl ?? '/api/v1';
  const transport = createHttpTransport({ fetchImpl: options.fetchImpl });
  return {
    async getCommandStatus(fabId, commandId) {
      let body: unknown;
      try {
        body = await transport.fetchJson(baseUrl + '/commands/' + encodeURIComponent(commandId));
      } catch (error: unknown) {
        if (error instanceof HttpStatusError && error.status === 404) return null;
        throw error;
      }
      const parsed = submittedEquipmentCommandSchema.parse(body);
      if (!commandIdentityMatches(fabId, parsed.fabId) || !commandIdentityMatches(commandId, parsed.commandId))
        throw new Error('command status identity mismatch (FAB or commandId)');
      return { fabId: parsed.fabId, commandId: parsed.commandId,
        revision: parsed.revision, outcome: parsed.outcome, occurredAt: parsed.occurredAt };
    },
  };
}
