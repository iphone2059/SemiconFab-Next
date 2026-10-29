import type { Stream } from 'effect';

/**
 * Version-agnostic command-result contract. Realtime infrastructure and
 * workflows both depend on this file only; neither side knows the other's
 * implementation (ARCH-06/07, ADR-0010).
 */
export type CommandOutcome = 'accepted' | 'executing' | 'succeeded' | 'failed' | 'cancelled';

export interface CommandResultEvent {
  readonly fabId: string;
  readonly commandId: string;
  /** Monotonic revision within one command; dedupe/order is based on this, never occurredAt. */
  readonly revision: number;
  readonly outcome: CommandOutcome;
  /** ISO-8601 timestamp for display/audit only. */
  readonly occurredAt: string;
}

/**
 * Opaque recovery cursor (ADR-010 §2): the epoch scopes the sequence, and the
 * sequence is the last acknowledged/delivered journal position inside that epoch.
 * A cursor from another epoch is only usable as an authoritative-recovery trigger,
 * never as a continuation position.
 */
export interface CommandCursor {
  readonly epoch: string;
  readonly sequence: number;
}

/**
 * A disconnect could not be fully replayed from the backend journal (epoch
 * change, pruned cursor, malformed Last-Event-ID). Results may be missing, so
 * consumers must reconcile authoritative command state instead of guessing.
 */
export interface CommandStreamGap {
  /** Server journal epoch that could not be replayed, when the backend reports it. */
  readonly epoch?: string;
  /** Last sequence observed for that epoch before the gap, when known. */
  readonly sequence?: number;
  /** Raw backend cursor/details for diagnostics only; never parsed as business state. */
  readonly cursor?: string;
}

export type CommandConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'failed';

/**
 * Why the bounded command transport bus could not deliver every frame (ADR-010 §2).
 * A dirty signal is a correctness event, never a counter-only diagnostic: the
 * consumer must reconcile authoritative command state. Server-classified causes
 * are mapped onto server-overflow/stale-generation/store-fault.
 */
export type CommandStreamDirtyReason =
  | 'overflow'
  | 'slow-consumer'
  | 'stale-generation'
  | 'closed'
  | 'server-overflow'
  | 'store-fault';

/**
 * The transport lost frames. The monotonic droppedCount preserves the loss
 * accounting even when several dirty signals coalesce. The conservative
 * delivered cursor is the recovery start point; gapStart/gapEnd describe the
 * exact dropped sequence range when it is known. An absent gapStart means the
 * gap origin is unknown and the consumer must use full authoritative recovery.
 */
export interface CommandStreamDirty {
  readonly reason: CommandStreamDirtyReason;
  /** Monotonic total frame drops observed by this transport/server. */
  readonly droppedCount: number;
  /** Conservative delivered (or acknowledged when more conservative) cursor. */
  readonly delivered?: CommandCursor;
  /** Smallest dropped journal sequence (inclusive); undefined = unknown origin. */
  readonly gapStart?: number;
  /** Largest dropped journal sequence (inclusive); undefined = unknown end. */
  readonly gapEnd?: number;
}

/** Conservative transport cursors (ADR-010 §2); never a second source of truth. */
export interface CommandSourceCursors {
  readonly observed?: CommandCursor;
  readonly delivered?: CommandCursor;
  readonly acknowledged?: CommandCursor;
}

/** Transport-level command stream failure; never a business command outcome. */
export interface CommandTransportFailure {
  readonly message: string;
  readonly cause?: unknown;
}

export interface CommandEventSource {
  readonly commandResults: Stream.Stream<CommandResultEvent>;
  /** A live connection was restored; replay may no longer contain every result. */
  readonly reconnected?: Stream.Stream<void>;
  /**
   * Replay could not cover a disconnect (backend replay-gap); reconciliation of
   * tracked active commands is required. Optional so fakes/backends without gap
   * signalling remain valid sources.
   */
  readonly gaps?: Stream.Stream<CommandStreamGap>;
  /** Connection lifecycle for the shared FAB command stream (optional for fakes). */
  readonly connectionStatus?: Stream.Stream<CommandConnectionStatus>;
  /**
   * Transport failure/interruption signal. A failed connection must be observable
   * and must trigger bounded authoritative reconciliation; it is never reported as
   * a command failed/cancelled outcome.
   */
  readonly transportFailures?: Stream.Stream<CommandTransportFailure>;
  /**
   * Bounded-bus overflow/coalescing signal. A delivered dirty frame means every
   * tracked active command must be reconciled authoritatively; the signal is
   * carried on its own coalescing channel so overflow of the result bus cannot
   * silence it.
   */
  readonly dirty?: Stream.Stream<CommandStreamDirty>;
  /**
   * Consumer -> transport confirmation that a delivered event was applied to the
   * authoritative actor (ADR-010 §2). Only this advances the acknowledged cursor,
   * which is the recovery start point after a reconnect. Unknown/duplicate acks
   * are ignored, stale acks can never move the cursor backwards.
   */
  acknowledge(event: CommandResultEvent): void;
  /** Conservative cursor snapshot; recovery/reconnect must start from acknowledged. */
  readonly cursors: CommandSourceCursors;
}

export interface AlarmEvent {
  readonly fabId: string;
  readonly alarmId: string;
  readonly severity: 'info' | 'warning' | 'critical';
  readonly message: string;
  readonly occurredAt: string;
}

export interface TelemetrySample {
  readonly entityId: string;
  readonly values: Readonly<Record<string, number>>;
}

/** Low-frequency aggregate frame only; high-frequency telemetry stays on the Worker/TypedArray path (ARCH-11). */
export interface TelemetryFrame {
  readonly fabId: string;
  readonly sequence: number;
  readonly capturedAt: string;
  readonly samples: readonly TelemetrySample[];
}
