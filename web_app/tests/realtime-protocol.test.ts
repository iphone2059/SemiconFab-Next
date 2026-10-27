import { expect, it } from 'vitest';
import {
  ALARM_TOPIC,
  COMMAND_RESULT_TOPIC,
  MessageDecoder,
  RealtimeDecodeError,
  TELEMETRY_TOPIC,
} from '../src/realtime/protocol/MessageDecoder';

const commandFrame = JSON.stringify({
  topic: COMMAND_RESULT_TOPIC,
  sequence: 1,
  payload: { fabId: 'fab', commandId: 'cmd', revision: 1, outcome: 'executing', occurredAt: '2026-10-27T00:00:00Z' },
});

it('decodes command/alarm/telemetry envelopes into typed events', () => {
  const decoder = new MessageDecoder();
  expect(decoder.decode(commandFrame)).toMatchObject({ kind: 'command', event: { fabId: 'fab', revision: 1 } });
  expect(decoder.decode({ topic: ALARM_TOPIC, payload: { fabId: 'fab', alarmId: 'a1', severity: 'warning', message: 'm', occurredAt: 'now' } }))
    .toMatchObject({ kind: 'alarm', event: { alarmId: 'a1' } });
  expect(decoder.decode({ topic: TELEMETRY_TOPIC, payload: { fabId: 'fab', sequence: 1, capturedAt: 'now', samples: [{ entityId: 'e1', values: { temp: 21 } }] } }))
    .toMatchObject({ kind: 'telemetry', event: { samples: [{ entityId: 'e1' }] } });
});

it('rejects malformed and unknown frames without swallowing the error type', () => {
  const decoder = new MessageDecoder();
  expect(() => decoder.decode('not json')).toThrow(RealtimeDecodeError);
  expect(() => decoder.decode(JSON.stringify({}))).toThrow(/envelope/);
  expect(() => decoder.decode(JSON.stringify({ topic: 'bogus', payload: {} }))).toThrow(/topic/);
  expect(() => decoder.decode(JSON.stringify({ topic: COMMAND_RESULT_TOPIC, payload: { revision: -1 } }))).toThrow(/payload/);
  expect(() => new MessageDecoder(20).decode('x'.repeat(21))).toThrow(/size/);
});
