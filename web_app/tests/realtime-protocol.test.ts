import { expect, it } from 'vitest';
import {
  ALARM_TOPIC,
  COMMAND_RESULT_TOPIC,
  MessageDecoder,
  RealtimeDecodeError,
  TELEMETRY_TOPIC,
} from '../src/realtime/protocol/MessageDecoder';
import { SequenceTracker } from '../src/realtime/protocol/SequenceTracker';
import { EventRouter } from '../src/realtime/streams/EventRouter';

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

it('tracks per-topic order, duplicates, gaps and out-of-order frames', () => {
  const tracker = new SequenceTracker();
  expect(tracker.observe('t', 1)).toEqual({ decision: 'in-order' });
  expect(tracker.observe('t', 1)).toEqual({ decision: 'duplicate' });
  expect(tracker.observe('t', 3)).toEqual({ decision: 'gap', expected: 2 });
  expect(tracker.observe('t', 2)).toEqual({ decision: 'out-of-order' });
  expect(tracker.observe('t', 4)).toEqual({ decision: 'in-order' });
  expect(tracker.observe('other', 7)).toEqual({ decision: 'in-order' });
  expect(tracker.lastSequence('t')).toBe(4);
});

it('routes typed streams, drops duplicate sequences and reports gaps/decode errors', () => {
  const router = new EventRouter();
  const commands: unknown[] = [];
  const alarms: unknown[] = [];
  const telemetry: unknown[] = [];
  const gaps: unknown[] = [];
  const errors: unknown[] = [];
  const subscription = router.commandResult$.subscribe((value) => commands.push(value));
  router.alarm$.subscribe((value) => alarms.push(value));
  router.telemetry$.subscribe((value) => telemetry.push(value));
  router.gaps$.subscribe((value) => gaps.push(value));
  router.errors$.subscribe((value) => errors.push(value));

  router.route(commandFrame);
  router.route(commandFrame); // duplicate sequence
  router.route(JSON.stringify({ topic: COMMAND_RESULT_TOPIC, sequence: 3, payload: { fabId: 'fab', commandId: 'cmd', revision: 3, outcome: 'succeeded', occurredAt: 'now' } })); // gap (2 missing)
  router.route(JSON.stringify({ topic: COMMAND_RESULT_TOPIC, sequence: 2, payload: { fabId: 'fab', commandId: 'cmd', revision: 2, outcome: 'executing', occurredAt: 'now' } })); // out-of-order
  router.route({ topic: ALARM_TOPIC, payload: { fabId: 'fab', alarmId: 'a1', severity: 'info', message: 'm', occurredAt: 'now' } });
  router.route({ topic: TELEMETRY_TOPIC, payload: { fabId: 'fab', sequence: 1, capturedAt: 'now', samples: [] } });
  router.route('bad json');

  expect(commands.map((value) => (value as { revision: number }).revision)).toEqual([1, 3]);
  expect(alarms).toHaveLength(1);
  expect(telemetry).toHaveLength(1);
  expect(gaps).toEqual([{ topic: COMMAND_RESULT_TOPIC, expected: 2, received: 3 }]);
  expect(errors).toHaveLength(1);
  subscription.unsubscribe();
  router.dispose();
});
