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
 * Opaque recovery cursor (ADR-010 §2/§6.2): the epoch scopes the sequence, and
 * the sequence is the last safely acknowledged journal position inside that epoch.
 * A cursor from another epoch is only usable as an authoritative-recovery trigger,
 * never as a continuation position.
 */
export interface CommandCursor {
  readonly epoch: string;
  readonly sequence: number;
}

export type CommandRecoveryCoverageKind = 'journal' | 'list';

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
 * Why the bounded command transport could not deliver/advance safely. A dirty
 * signal is a correctness event, never a counter-only diagnostic: the consumer
 * must reconcile authoritative command state (ADR-010 §2/§6.4).
 *
 * - overflow / slow-consumer / closed: local bounded bus/connection conditions;
 * - server-overflow / store-fault: server-classified loss;
 * - stale-generation: connection generation or epoch replaced;
 * - decode-error: a command data frame (or command payload) could not be decoded;
 * - invalid-control-frame: a server dirty/replay control frame could not be decoded;
 * - protocol-error: unknown topic / unprovable frame identity / non-monotonic cursor;
 * - ack-ledger-overflow: the ordered ACK ledger reached its bound and cannot
 *   advance until an authoritative cover arrives (never evict pending entries).
 *   A stalled applied-prefix (a later event applied while an earlier delivered
 *   event is still pending, e.g. its actor never materialised) is reported as
 *   slow-consumer with a payload-free diagnostic detail: the safe prefix stays
 *   put and authoritative recovery must cover the blocked range.
 */
export type CommandStreamDirtyReason =
  | 'overflow'
  | 'slow-consumer'
  | 'stale-generation'
  | 'closed'
  | 'server-overflow'
  | 'store-fault'
  | 'decode-error'
  | 'invalid-control-frame'
  | 'protocol-error'
  | 'ack-ledger-overflow';

/**
 * The transport lost progress. The monotonic droppedCount preserves the loss
 * accounting even when several dirty signals coalesce. `delivered` is the
 * *safe* recovery start (never a cursor that would skip an unapplied/unsafe
 * event); gapStart/gapEnd describe the exact dropped sequence range when known.
 * An absent gapStart means the origin is unknown/non-contiguous and the consumer
 * must use full authoritative List recovery.
 */
export interface CommandStreamDirty {
  readonly reason: CommandStreamDirtyReason;
  /** Monotonic total frame drops observed by this transport/server. */
  readonly droppedCount: number;
  /** Safe delivered (or acknowledged when more conservative) cursor. */
  readonly delivered?: CommandCursor;
  /** Smallest dropped journal sequence (inclusive); undefined = unknown origin. */
  readonly gapStart?: number;
  /** Largest dropped journal sequence (inclusive); undefined = unknown end. */
  readonly gapEnd?: number;
}

/**
 * Conservative transport cursors (ADR-010 §2/§6.2); never a second source of
 * truth. `acknowledged` is the last safe ACK prefix: every earlier delivered
 * event has been applied (or authoritatively covered).
 */
export interface CommandSourceCursors {
  readonly observed?: CommandCursor;
  readonly delivered?: CommandCursor;
  readonly acknowledged?: CommandCursor;
  /** Delivered events still waiting for their ordered applied prefix (bounded). */
  readonly pendingAcknowledgements?: number;
}

/** Bounded protocol diagnostics kind; payload-free by contract (ADR-010 §6.4). */
export type CommandProtocolDiagnosticKind = 'decode' | 'control-frame' | 'ack-ledger' | 'epoch';

/**
 * Bounded, payload-free protocol diagnostic. It must never contain raw frame
 * data, exception bodies or other sensitive payload; only a fixed reason enum-
 * style string plus cursor positions for correlation.
 */
export interface CommandProtocolDiagnostic {
  readonly at: number;
  readonly kind: CommandProtocolDiagnosticKind;
  readonly reason: string;
  readonly epoch?: string;
  readonly sequence?: number;
}

/**
 * Source availability marker. An `unavailable` source (e.g. EventSource absent
 * in jsdom) cannot be an authoritative recovery authority; consumers must not
 * treat it as recoverable/Healthy (R3-07/Round 3 §6.5).
 */
export type CommandSourceAvailability = 'ready' | 'unavailable';

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
   * silence it. Consumers keep a sticky Dirty state until authoritative recovery
   * signs off (ADR-010 §6.4).
   */
  readonly dirty?: Stream.Stream<CommandStreamDirty>;
  /**
   * Consumer -> transport confirmation that a delivered event was applied to the
   * authoritative actor (ADR-010 §6.2). The transport tracks an ordered delivered
   * ledger (pending/applied/covered) and advances `acknowledged` only over a
   * contiguous applied|covered prefix: acknowledging a later sequence can never
   * skip an earlier pending event. Unknown/duplicate/stale acks are ignored.
   */
  acknowledge(event: CommandResultEvent): void;
  /**
   * Authoritative recovery safe watermark (ADR-010 §6.2). Only the *current*
   * recovery generation may call this after a Journal loop reached
   * `latestSequence` or an authoritative List snapshot was applied; entries at or
   * before the cursor become covered, an authoritative epoch replacement is
   * accepted here (never through data frames), and late/stale ledger entries must
   * not roll the acknowledged cursor back. Transport implementations must also
   * never regress the same-epoch acknowledged sequence.
   */
  /** Monotonic generation for unlocated losses; a pass captures it before its authority read. */
  readonly recoveryVersion: number;
  /** Returns false when the pass raced a new loss or its watermark cannot prove coverage. */
  cover(cursor: CommandCursor, recoveryVersion: number, kind: CommandRecoveryCoverageKind): boolean;
  /**
   * Bounded protocol diagnostics (payload-free). Implementations keep the last N
   * causes/timestamps so malformed frames are observable without leaking payload
   * or unbounded memory (ADR-010 §6.4).
   */
  readonly protocolDiagnostics: readonly CommandProtocolDiagnostic[];
  /** Ready/unavailable marker; unavailable sources are not a recovery authority. */
  readonly availability: CommandSourceAvailability;
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
