import { Option, Schema } from 'effect';
import { finiteNumber, nonEmptyString, nonNegativeInteger } from '@/api/primitives.schema';
import type { AlarmEvent, CommandResultEvent, TelemetryFrame } from '@/contracts/command-events.contract';

export const COMMAND_RESULT_TOPIC = 'command.result';
export const ALARM_TOPIC = 'alarm.event';
export const TELEMETRY_TOPIC = 'telemetry.frame';

const envelopeSchema = Schema.Struct({
  topic: nonEmptyString,
  sequence: Schema.optional(nonNegativeInteger),
  payload: Schema.Unknown,
});

const commandResultSchema = Schema.Struct({
  fabId: nonEmptyString,
  commandId: nonEmptyString,
  revision: nonNegativeInteger,
  outcome: Schema.Literals(['accepted', 'executing', 'succeeded', 'failed', 'cancelled']),
  occurredAt: nonEmptyString,
});

const alarmSchema = Schema.Struct({
  fabId: nonEmptyString,
  alarmId: nonEmptyString,
  severity: Schema.Literals(['info', 'warning', 'critical']),
  message: Schema.String,
  occurredAt: nonEmptyString,
});

const telemetrySchema = Schema.Struct({
  fabId: nonEmptyString,
  sequence: nonNegativeInteger,
  capturedAt: nonEmptyString,
  samples: Schema.Array(Schema.Struct({
    entityId: nonEmptyString,
    values: Schema.Record(Schema.String, finiteNumber),
  })).pipe(Schema.mutable),
});

export type DecodedRealtimeMessage =
  | { readonly kind: 'command'; readonly topic: string; readonly sequence?: number; readonly event: CommandResultEvent }
  | { readonly kind: 'alarm'; readonly topic: string; readonly sequence?: number; readonly event: AlarmEvent }
  | { readonly kind: 'telemetry'; readonly topic: string; readonly sequence?: number; readonly event: TelemetryFrame };

export class RealtimeDecodeError extends Error {
  readonly topic: string | undefined;
  constructor(message: string, topic?: string) {
    super(message);
    this.name = 'RealtimeDecodeError';
    this.topic = topic;
  }
}

/**
 * Wire decoder for the realtime protocol. It validates the envelope and payload
 * once at the infrastructure boundary; consumers receive typed events only.
 */
export class MessageDecoder {
  constructor(private readonly maxBytes = 1_000_000) {}

  decode(raw: unknown): DecodedRealtimeMessage {
    let value: unknown = raw;
    if (typeof raw === 'string') {
      if (raw.length > this.maxBytes) throw new RealtimeDecodeError('realtime message exceeded max size');
      try {
        value = JSON.parse(raw);
      } catch {
        throw new RealtimeDecodeError('realtime message was not JSON');
      }
    }
    const envelope = Schema.decodeUnknownOption(envelopeSchema)(value);
    if (Option.isNone(envelope)) throw new RealtimeDecodeError('invalid realtime envelope');
    const { topic, sequence, payload } = envelope.value;
    if (topic === COMMAND_RESULT_TOPIC) {
      const parsed = Schema.decodeUnknownOption(commandResultSchema)(payload);
      if (Option.isNone(parsed)) throw new RealtimeDecodeError('invalid command result payload', topic);
      return { kind: 'command', topic, sequence, event: parsed.value };
    }
    if (topic === ALARM_TOPIC) {
      const parsed = Schema.decodeUnknownOption(alarmSchema)(payload);
      if (Option.isNone(parsed)) throw new RealtimeDecodeError('invalid alarm payload', topic);
      return { kind: 'alarm', topic, sequence, event: parsed.value };
    }
    if (topic === TELEMETRY_TOPIC) {
      const parsed = Schema.decodeUnknownOption(telemetrySchema)(payload);
      if (Option.isNone(parsed)) throw new RealtimeDecodeError('invalid telemetry payload', topic);
      return { kind: 'telemetry', topic, sequence, event: parsed.value };
    }
    throw new RealtimeDecodeError('unknown realtime topic', topic);
  }
}
