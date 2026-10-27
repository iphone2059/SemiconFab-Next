export interface ResearchEvent {
  timestamp_sec: number;
  event_type: string;
  payload: Record<string, unknown>;
}

interface WipSample {
  time: number;
  wip: number;
}

interface MachineTransition {
  time: number;
  state: string;
  toolGroup: string;
}

export interface ResearchUtilization {
  toolGroup: string;
  total: number;
  busy: number;
  utilization: number;
}

export interface ResearchSnapshot {
  timeSec: number;
  wip: number;
  activeTools: number;
  utilization: ResearchUtilization[];
  machineStates: ReadonlyMap<string, string>;
}

const PRODUCTIVE_STATE = 'PR_productive';

function lastAtOrBefore<T extends { time: number }>(values: readonly T[], time: number): T | undefined {
  let low = 0;
  let high = values.length - 1;
  let found: T | undefined;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (values[middle].time <= time) {
      found = values[middle];
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}

/** Indexes the original 27,263-line display stream; it is not an authoritative WAL. */
export class ResearchReplay {
  readonly durationSec: number;
  readonly eventCount: number;
  private readonly wipSamples: WipSample[];
  private readonly machines = new Map<string, MachineTransition[]>();
  private readonly groupTotals = new Map<string, Set<string>>();

  private constructor(events: readonly ResearchEvent[]) {
    this.eventCount = events.length;
    // Scan for the maximum while building the index: Math.max(...timestamps) allocates
    // an O(N) argument array and throws RangeError once the display stream exceeds the
    // engine's argument-count limit.
    let durationSec = events.length ? events[0].timestamp_sec : 0;
    const wip: WipSample[] = [];
    for (const event of events) {
      if (event.timestamp_sec > durationSec) durationSec = event.timestamp_sec;
      if (event.event_type === 'wip_sample') {
        const value = Number(event.payload.wip_count);
        if (Number.isFinite(value)) wip.push({ time: event.timestamp_sec, wip: value });
        continue;
      }
      if (event.event_type !== 'tool_state_change') continue;
      const machine = event.payload.machine_id;
      const state = event.payload.semi_e10_state;
      const group = event.payload.tool_group_id;
      if (typeof machine !== 'string' || typeof state !== 'string' || typeof group !== 'string') continue;
      const history = this.machines.get(machine) ?? [];
      history.push({ time: event.timestamp_sec, state, toolGroup: group });
      this.machines.set(machine, history);
      const members = this.groupTotals.get(group) ?? new Set<string>();
      members.add(machine);
      this.groupTotals.set(group, members);
    }
    this.durationSec = durationSec;
    this.wipSamples = wip;
  }

  static parse(text: string): ResearchReplay {
    const events: ResearchEvent[] = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line) as Partial<ResearchEvent>;
        if (typeof value.timestamp_sec !== 'number' || !Number.isFinite(value.timestamp_sec) ||
            typeof value.event_type !== 'string' || !value.payload || typeof value.payload !== 'object') continue;
        events.push({ timestamp_sec: value.timestamp_sec, event_type: value.event_type, payload: value.payload });
      } catch {
        // Skip malformed display rows; the source stays immutable.
      }
    }
    events.sort((a, b) => a.timestamp_sec - b.timestamp_sec);
    return new ResearchReplay(events);
  }

  snapshot(timeSec: number): ResearchSnapshot {
    const time = Math.max(0, Math.min(this.durationSec, timeSec));
    const wip = lastAtOrBefore(this.wipSamples, time)?.wip ?? 0;
    const busyByGroup = new Map<string, number>();
    const machineStates = new Map<string, string>();
    let activeTools = 0;
    for (const [machineId, history] of this.machines) {
      const latest = lastAtOrBefore(history, time);
      machineStates.set(machineId, latest?.state ?? 'SBY_standby');
      if (!latest) continue;
      if (latest.state === PRODUCTIVE_STATE) {
        activeTools++;
        busyByGroup.set(latest.toolGroup, (busyByGroup.get(latest.toolGroup) ?? 0) + 1);
      }
    }
    const utilization = [...this.groupTotals.entries()].map(([toolGroup, members]) => {
      const total = members.size;
      const busy = busyByGroup.get(toolGroup) ?? 0;
      return { toolGroup, total, busy, utilization: total ? (busy / total) * 100 : 0 };
    }).sort((a, b) => b.utilization - a.utilization || a.toolGroup.localeCompare(b.toolGroup));
    return { timeSec: time, wip, activeTools, utilization, machineStates };
  }
}

export function researchClock(timeSec: number): string {
  const total = Math.max(0, Math.floor(timeSec));
  const day = Math.floor(total / 86400) + 1;
  const remainder = total % 86400;
  const hh = String(Math.floor(remainder / 3600)).padStart(2, '0');
  const mm = String(Math.floor((remainder % 3600) / 60)).padStart(2, '0');
  const ss = String(remainder % 60).padStart(2, '0');
  return `Day ${String(day).padStart(2, '0')} ${hh}:${mm}:${ss}`;
}
