import { describe, expect, it } from 'vitest';
import { ResearchReplay, researchClock } from '../../src/domain/simulation/research-replay';

const stream = [
  { timestamp_sec: 0, event_type: 'wip_sample', payload: { wip_count: 5 } },
  { timestamp_sec: 0, event_type: 'tool_state_change', payload: { machine_id: 'A', tool_group_id: 'TG1', semi_e10_state: 'PR_productive' } },
  { timestamp_sec: 0, event_type: 'tool_state_change', payload: { machine_id: 'B', tool_group_id: 'TG1', semi_e10_state: 'PR_productive' } },
  { timestamp_sec: 5, event_type: 'tool_state_change', payload: { machine_id: 'A', tool_group_id: 'TG1', semi_e10_state: 'SBY_standby' } },
  { timestamp_sec: 10, event_type: 'wip_sample', payload: { wip_count: 7 } },
].map((event) => JSON.stringify(event)).join('\n');

describe('ResearchReplay', () => {
  it('indexes WIP and machine transitions without loading DOM state', () => {
    const replay = ResearchReplay.parse(stream);
    expect(replay.eventCount).toBe(5);
    expect(replay.durationSec).toBe(10);
    const start = replay.snapshot(0);
    expect(start.wip).toBe(5);
    expect(start.activeTools).toBe(2);
    expect(start.utilization[0]).toMatchObject({ toolGroup: 'TG1', total: 2, busy: 2, utilization: 100 });
    const later = replay.snapshot(6);
    expect(later.wip).toBe(5);
    expect(later.activeTools).toBe(1);
    expect(later.utilization[0]).toMatchObject({ busy: 1, utilization: 50 });
    expect(replay.snapshot(10).wip).toBe(7);
  });

  it('formats the original Day clock', () => {
    expect(researchClock(0)).toBe('Day 01 00:00:00');
    expect(researchClock(86400 + 3661)).toBe('Day 02 01:01:01');
  });
});

describe('ResearchReplay.parse boundaries', () => {
  it('parses a 200k-event stream without argument-count RangeError and reports the max timestamp', () => {
    // Math.max(...timestamps) throws RangeError around 150k events in this engine;
    // the parser must find the maximum with a linear scan instead of argument spread.
    const count = 200_000;
    const lines: string[] = new Array(count);
    for (let index = 0; index < count; index += 1) {
      lines[index] = `{"timestamp_sec":${index % 1000},"event_type":"wip_sample","payload":{"wip_count":${index % 7}}}`;
    }
    const replay = ResearchReplay.parse(lines.join('\n'));
    expect(replay.eventCount).toBe(count);
    expect(replay.durationSec).toBe(999);
    // The last event at time 999 is index 199999 (stable sort keeps emission order).
    expect(replay.snapshot(999).wip).toBe(199999 % 7);
  });

  it('returns duration 0 for empty text', () => {
    const replay = ResearchReplay.parse('');
    expect(replay.eventCount).toBe(0);
    expect(replay.durationSec).toBe(0);
    expect(replay.snapshot(0)).toMatchObject({ timeSec: 0, wip: 0, activeTools: 0 });
  });

  it('sorts out-of-order timestamps and keeps the last WIP sample at or before the seek time', () => {
    const text = [
      { timestamp_sec: 10, event_type: 'wip_sample', payload: { wip_count: 30 } },
      { timestamp_sec: 5, event_type: 'wip_sample', payload: { wip_count: 20 } },
      { timestamp_sec: 20, event_type: 'wip_sample', payload: { wip_count: 40 } },
      { timestamp_sec: 5, event_type: 'tool_state_change', payload: { machine_id: 'M1', tool_group_id: 'TG1', semi_e10_state: 'PR_productive' } },
    ].map((event) => JSON.stringify(event)).join('\r\n');
    const replay = ResearchReplay.parse(text);
    expect(replay.durationSec).toBe(20);
    expect(replay.snapshot(7).wip).toBe(20);
    expect(replay.snapshot(15).wip).toBe(30);
    expect(replay.snapshot(20).wip).toBe(40);
    expect(replay.snapshot(7).activeTools).toBe(1);
  });

  it('skips malformed rows and rows missing required display fields', () => {
    const text = [
      '{"timestamp_sec":1,"event_type":"wip_sample","payload":{"wip_count":5}}',
      'not json at all',
      '{"timestamp_sec":"2","event_type":"wip_sample","payload":{"wip_count":7}}',
      '{"event_type":"wip_sample","payload":{"wip_count":9}}',
      '{"timestamp_sec":3,"event_type":"wip_sample"}',
      '   ',
      '{"timestamp_sec":4,"event_type":"noop","payload":{}}',
      '{"timestamp_sec":5,"event_type":"wip_sample","payload":{"wip_count":6}}',
    ].join('\n');
    const replay = ResearchReplay.parse(text);
    expect(replay.eventCount).toBe(3);
    expect(replay.durationSec).toBe(5);
    expect(replay.snapshot(5).wip).toBe(6);
  });
});
