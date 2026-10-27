import type { Observable } from 'rxjs';
import type { AlarmEvent, CommandResultEvent, TelemetryFrame } from './CommandEvents';

/** Typed stream surface exposed by the realtime infrastructure. */
export interface RealtimeStreams {
  readonly commandResult$: Observable<CommandResultEvent>;
  readonly alarm$: Observable<AlarmEvent>;
  readonly telemetry$: Observable<TelemetryFrame>;
}

export interface RealtimeConnection {
  readonly streams: RealtimeStreams;
  close(): void;
}

/** Transport-agnostic gateway; the concrete WebSocket client is assembled by the Runtime. */
export interface RealtimeGateway {
  connect(): Promise<RealtimeConnection>;
}
