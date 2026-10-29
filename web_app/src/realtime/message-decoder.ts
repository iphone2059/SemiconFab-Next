import { z } from 'zod';
import type { AlarmEvent, CommandResultEvent, TelemetryFrame } from '@/contracts/command-events.contract';

export const COMMAND_RESULT_TOPIC = 'command.result';
export const ALARM_TOPIC = 'alarm.event';
export const TELEMETRY_TOPIC = 'telemetry.frame';

const envelopeSchema = z.object({
  topic: z.string().min(1),
  sequence: z.number().int().nonnegative().optional(),
  payload: z.unknown(),
});

const commandResultSchema = z.object({
  fabId: z.string().min(1),
  commandId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  outcome: z.enum(['accepted', 'executing', 'succeeded', 'failed', 'cancelled']),
  occurredAt: z.string().min(1),
});

const alarmSchema = z.object({
  fabId: z.string().min(1),
  alarmId: z.string().min(1),
  severity: z.enum(['info', 'warning', 'critical']),
  message: z.string(),
  occurredAt: z.string().min(1),
});

const telemetrySchema = z.object({
  fabId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  capturedAt: z.string().min(1),
  samples: z.array(z.object({
    entityId: z.string().min(1),
    values: z.record(z.string(), z.number()),
  })),
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
    const envelope = envelopeSchema.safeParse(value);
    if (!envelope.success) throw new RealtimeDecodeError('invalid realtime envelope');
    const { topic, sequence, payload } = envelope.data;
    if (topic === COMMAND_RESULT_TOPIC) {
      const parsed = commandResultSchema.safeParse(payload);
      if (!parsed.success) throw new RealtimeDecodeError('invalid command result payload', topic);
      return { kind: 'command', topic, sequence, event: parsed.data };
    }
    if (topic === ALARM_TOPIC) {
      const parsed = alarmSchema.safeParse(payload);
      if (!parsed.success) throw new RealtimeDecodeError('invalid alarm payload', topic);
      return { kind: 'alarm', topic, sequence, event: parsed.data };
    }
    if (topic === TELEMETRY_TOPIC) {
      const parsed = telemetrySchema.safeParse(payload);
      if (!parsed.success) throw new RealtimeDecodeError('invalid telemetry payload', topic);
      return { kind: 'telemetry', topic, sequence, event: parsed.data };
    }
    throw new RealtimeDecodeError('unknown realtime topic', topic);
  }
}
