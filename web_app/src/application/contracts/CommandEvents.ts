import type { Observable } from 'rxjs';

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

export interface CommandEventSource {
  readonly commandResult$: Observable<CommandResultEvent>;
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
