import { Subject, filter, map, share, type Observable } from 'rxjs';
import type { AlarmEvent, CommandResultEvent, TelemetryFrame } from '../../application/contracts/CommandEvents';
import type { RealtimeStreams } from '../../application/contracts/RealtimeGateway';
import { MessageDecoder, RealtimeDecodeError, type DecodedRealtimeMessage } from '../protocol/MessageDecoder';
import { SequenceTracker } from '../protocol/SequenceTracker';
import { createAlarmStream } from './AlarmStream';
import { createCommandResultStream } from './CommandResultStream';
import { createTelemetryStream } from './TelemetryStream';

export interface SequenceGap {
  readonly topic: string;
  readonly expected: number;
  readonly received: number;
}

/**
 * Realtime stream router: raw transport frames -> validated typed streams.
 * It knows only the wire protocol: no workflows, no XState, no business dedupe
 * (ARCH-06). Sequence filtering here is transport ordering only.
 */
export class EventRouter implements RealtimeStreams {
  private readonly raw = new Subject<unknown>();
  private readonly errorsSubject = new Subject<RealtimeDecodeError>();
  private readonly gapsSubject = new Subject<SequenceGap>();
  private readonly sequences = new SequenceTracker();
  readonly commandResult$: Observable<CommandResultEvent>;
  readonly alarm$: Observable<AlarmEvent>;
  readonly telemetry$: Observable<TelemetryFrame>;

  constructor(private readonly decoder = new MessageDecoder()) {
    const decoded$ = this.raw.pipe(
      map((raw): DecodedRealtimeMessage | undefined => {
        try {
          return this.decoder.decode(raw);
        } catch (error) {
          this.errorsSubject.next(error instanceof RealtimeDecodeError ? error : new RealtimeDecodeError(String(error)));
          return undefined;
        }
      }),
      filter((message): message is DecodedRealtimeMessage => message !== undefined),
      filter((message) => {
        if (message.sequence === undefined) return true;
        const observation = this.sequences.observe(message.topic, message.sequence);
        if (observation.decision === 'gap') {
          this.gapsSubject.next({ topic: message.topic, expected: observation.expected ?? -1, received: message.sequence });
        }
        return observation.decision !== 'duplicate' && observation.decision !== 'out-of-order';
      }),
      // One decode/sequence pass shared by every typed stream; without share()
      // each subscriber would decode the same raw frame independently.
      share(),
    );
    this.commandResult$ = createCommandResultStream(decoded$);
    this.alarm$ = createAlarmStream(decoded$);
    this.telemetry$ = createTelemetryStream(decoded$);
  }

  route(raw: unknown): void {
    this.raw.next(raw);
  }

  get errors$(): Observable<RealtimeDecodeError> {
    return this.errorsSubject.asObservable();
  }

  get gaps$(): Observable<SequenceGap> {
    return this.gapsSubject.asObservable();
  }

  dispose(): void {
    this.raw.complete();
    this.errorsSubject.complete();
    this.gapsSubject.complete();
  }
}
