import type { CommandOutcome } from '../../application/contracts/CommandEvents';
import type { CommandGateway } from '../../application/contracts/CommandGateway';

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface HttpCommandGatewayOptions {
  readonly baseUrl?: string;
  /** Test seam; production defaults to global fetch. */
  readonly fetchImpl?: FetchLike;
}

const OUTCOMES: ReadonlySet<string> = new Set(['accepted', 'executing', 'succeeded', 'failed', 'cancelled']);

/** Authoritative command-status query against the backend HTTP API. */
export function createHttpCommandGateway(options: HttpCommandGatewayOptions = {}): CommandGateway {
  const baseUrl = options.baseUrl ?? '/api/v1';
  const fetchImpl: FetchLike = options.fetchImpl ?? ((input, init) => fetch(input, init));

  return {
    async getCommandStatus(fabId, commandId) {
      const response = await fetchImpl(`${baseUrl}/commands/${encodeURIComponent(commandId)}`);
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`command status request failed: ${response.status}`);
      const body = await response.json() as Record<string, unknown>;
      if (
        typeof body.fabId !== 'string' ||
        typeof body.commandId !== 'string' ||
        typeof body.revision !== 'number' ||
        typeof body.outcome !== 'string' ||
        !OUTCOMES.has(body.outcome) ||
        typeof body.occurredAt !== 'string'
      ) {
        throw new Error('invalid command status response');
      }
      if (body.fabId !== fabId) throw new Error('command status returned for a different FAB');
      return {
        fabId: body.fabId,
        commandId: body.commandId,
        revision: body.revision,
        outcome: body.outcome as CommandOutcome,
        occurredAt: body.occurredAt,
      };
    },
  };
}
