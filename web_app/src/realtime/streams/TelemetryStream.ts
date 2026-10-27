import { filter, map, type Observable } from 'rxjs';
import type { TelemetryFrame } from '../../application/contracts/CommandEvents';
import type { DecodedRealtimeMessage } from '../protocol/MessageDecoder';

export const isTelemetry = (
  message: DecodedRealtimeMessage,
): message is Extract<DecodedRealtimeMessage, { kind: 'telemetry' }> => message.kind === 'telemetry';

export function createTelemetryStream(
  decoded$: Observable<DecodedRealtimeMessage>,
): Observable<TelemetryFrame> {
  return decoded$.pipe(filter(isTelemetry), map((message) => message.event));
}
