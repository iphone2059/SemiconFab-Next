import type { RealtimeConnection, RealtimeGateway, RealtimeStreams } from '../../application/contracts/RealtimeGateway';
import { EventRouter } from '../streams/EventRouter';

export type WebSocketFactory = (url: string) => WebSocket;

/**
 * Minimal WebSocket transport skeleton kept ready for the later backend
 * integration. It only feeds raw frames into the typed EventRouter; it contains
 * no business logic and is not assembled by the product until the runtime has a
 * real endpoint (M4+).
 */
export class WebSocketClient implements RealtimeGateway {
  private socket?: WebSocket;
  private readonly router = new EventRouter();

  constructor(
    private readonly url: string,
    private readonly factory: WebSocketFactory = (value) => new WebSocket(value),
  ) {}

  async connect(): Promise<RealtimeConnection> {
    if (this.socket) throw new Error('WebSocketClient is already connected');
    const socket = this.factory(this.url);
    this.socket = socket;
    socket.addEventListener('message', (event: MessageEvent) => {
      this.router.route(event.data);
    });
    const streams: RealtimeStreams = {
      commandResult$: this.router.commandResult$,
      alarm$: this.router.alarm$,
      telemetry$: this.router.telemetry$,
    };
    return { streams, close: () => { this.close(); } };
  }

  close(): void {
    this.socket?.close();
    this.socket = undefined;
    this.router.dispose();
  }
}
