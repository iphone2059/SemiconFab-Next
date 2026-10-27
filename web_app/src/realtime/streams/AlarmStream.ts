import { filter, map, type Observable } from 'rxjs';
import type { AlarmEvent } from '../../application/contracts/CommandEvents';
import type { DecodedRealtimeMessage } from '../protocol/MessageDecoder';

export const isAlarm = (
  message: DecodedRealtimeMessage,
): message is Extract<DecodedRealtimeMessage, { kind: 'alarm' }> => message.kind === 'alarm';

export function createAlarmStream(
  decoded$: Observable<DecodedRealtimeMessage>,
): Observable<AlarmEvent> {
  return decoded$.pipe(filter(isAlarm), map((message) => message.event));
}
