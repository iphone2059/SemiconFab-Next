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
 * Why the bounded command transport bus could not deliver every frame. A dirty
 * signal is a correctness event, never a counter-only diagnostic: the consumer
 * must run authoritative reconciliation through the FAB scheduler (ADR-007 §5).
 */
export type CommandStreamDirtyReason = 'overflow' | 'slow-consumer' | 'stale-generation' | 'closed';

/**
 * The transport dropped frames (slow consumer, bounded-bus overflow, a callback
 * from a stale connection generation, or a connection that could not be
 * established). The monotonic `droppedCount` preserves the loss amount even when
 * several dirty signals coalesce; it is never silently discarded.
 */
export interface CommandStreamDirty {
  readonly reason: CommandStreamDirtyReason;
  /** Monotonic total frame drops observed by this transport. */
  readonly droppedCount: number;
  /** Journal epoch last observed when the drop happened, when known. */
  readonly epoch?: string;
  /** Journal sequence last observed when the drop happened, when known. */
  readonly sequence?: number;
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
   * Replay could not cover a disconnect (backend `replay-gap`); reconciliation of
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
