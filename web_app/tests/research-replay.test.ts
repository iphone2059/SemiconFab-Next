import { describe, expect, it } from 'vitest';
import { ResearchReplay, researchClock } from '../src/research-replay';

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
