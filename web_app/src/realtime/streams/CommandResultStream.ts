import { filter, map, type Observable } from 'rxjs';
import type { CommandResultEvent } from '../../application/contracts/CommandEvents';
import type { DecodedRealtimeMessage } from '../protocol/MessageDecoder';

export const isCommandResult = (
  message: DecodedRealtimeMessage,
): message is Extract<DecodedRealtimeMessage, { kind: 'command' }> => message.kind === 'command';

export function createCommandResultStream(
  decoded$: Observable<DecodedRealtimeMessage>,
): Observable<CommandResultEvent> {
  return decoded$.pipe(filter(isCommandResult), map((message) => message.event));
}
