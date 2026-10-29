import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import {
  ENTITY_SLOT_PATTERN,
  FRAME_SIZE,
  SAMPLE_LIMIT,
  TOOL_STATES,
  boundTelemetryFrame,
  flattenTelemetryFrame,
  mergeTelemetryFrames,
  telemetrySlotForEntityId,
  toolStatesFromValues,
  type TelemetryProjectionFrame,
  type TelemetryProjectionSample,
} from '@/domain/equipment-tool-state-projection';

const sample = (entityId: string, state: number, utilization?: number): TelemetryProjectionSample => ({
  entityId,
  values: utilization === undefined ? { state } : { state, utilization },
});

const frame = (
  sequence: number,
  samples: readonly TelemetryProjectionSample[],
  capturedAt = '2026-10-27T00:00:00Z',
): TelemetryProjectionFrame => ({ fabId: 'fab-a', sequence, capturedAt, samples });

it('keeps the 16-slot / 2-floats-per-slot frame contract', () => {
  expect(SAMPLE_LIMIT).toBe(16);
  expect(FRAME_SIZE).toBe(32);
  expect([...TOOL_STATES]).toEqual(['running', 'idle', 'down', 'maint']);
  expect(ENTITY_SLOT_PATTERN.test('equipment-7')).toBe(true);
  expect(ENTITY_SLOT_PATTERN.test('external-7')).toBe(false);
  expect(telemetrySlotForEntityId('equipment-7')).toBe(7);
});

it('decodes equipment-<index> entity ids into render slots and rejects everything else', () => {
  expect([0, 1, 7, 15].map((index) => telemetrySlotForEntityId(`equipment-${index}`))).toEqual([0, 1, 7, 15]);
  for (const entityId of [
    'equipment-16', // outside the 16 render slots
    'equipment--1',
    'equipment-',
    'equipment',
    'external-0',
    'Equipment-0',
    'equipment-0:1',
    'equipment-1.5',
    '',
    'equipment-9007199254740993', // not a safe integer
  ]) {
    expect(telemetrySlotForEntityId(entityId), entityId).toBeUndefined();
  }
});

it('maps slot state values back to tool states with clamped, rounded state indexes', () => {
  const values = new Float32Array(FRAME_SIZE);
  values[0] = 0;
  values[2] = 1;
  values[4] = 2;
  values[6] = 3;
  values[8] = -4; // clamps to running
  values[10] = 5.4; // rounds/clamps to maint
  values[12] = 1.6; // rounds to down
  expect(toolStatesFromValues(values)).toEqual([
    'running', 'idle', 'down', 'maint', 'running', 'maint', 'down',
    ...Array(9).fill('running'),
  ]);
});

it('decodes missing/short value buffers to the legacy zero/running default', () => {
  expect(toolStatesFromValues([])).toEqual(Array(16).fill('running'));
  expect(toolStatesFromValues([2])).toEqual(['down', ...Array(15).fill('running')]);
});

it('flattens shuffled samples into stable slots and keeps the running default for untouched slots', () => {
  const flattened = flattenTelemetryFrame(frame(1, [
    sample('equipment-3', 2, 0.5),
    sample('equipment-0', 1, 0.25),
    sample('unknown-entity', 3),
    sample('equipment-16', 2),
  ]));
  expect(flattened.sequence).toBe(1);
  expect(flattened.values).toBeInstanceOf(Float32Array);
  expect(flattened.values).toHaveLength(32);
  expect([...flattened.values.slice(0, 2)]).toEqual([1, 0.25]);
  expect([...flattened.values.slice(6, 8)]).toEqual([2, 0.5]);
  expect(flattened.toolStates).toHaveLength(16);
  expect(flattened.toolStates[0]).toBe('idle');
  expect(flattened.toolStates[3]).toBe('down');
  expect(flattened.toolStates[1]).toBe('running');
});

it('retains previous slot values for entities missing from a later frame', () => {
  const first = flattenTelemetryFrame(frame(1, [sample('equipment-0', 2, 0.5), sample('equipment-7', 3, 0.5)]));
  const later = flattenTelemetryFrame(frame(2, [sample('equipment-7', 1, 0.5)]), first.values);
  expect(later.toolStates[0]).toBe('down'); // kept, not defaulted back to running
  expect(later.toolStates[7]).toBe('idle');
  // The inherited buffer is read only; the first frame's values are unchanged.
  expect(first.values[0]).toBe(2);
});

it('ignores duplicate entity ids after their first occurrence', () => {
  const flattened = flattenTelemetryFrame(frame(1, [
    sample('equipment-0', 3, 0.1),
    sample('equipment-0', 1, 0.9),
    sample('equipment-1', 0.6),
  ]));
  expect(flattened.toolStates[0]).toBe('maint');
  expect(flattened.values[1]).toBeCloseTo(0.1);
  expect(flattened.toolStates[1]).toBe('idle'); // 0.6 rounds to index 1
});

it('clamps state indexes and utilization into the projected frame', () => {
  const flattened = flattenTelemetryFrame(frame(1, [
    sample('equipment-0', 9, 1.5),
    sample('equipment-1', -2, -0.5),
    sample('equipment-2', 2, 2),
  ]));
  expect([...flattened.values.slice(0, 6)]).toEqual([3, 1, 0, 0, 2, 1]);
  expect(flattened.toolStates.slice(0, 3)).toEqual(['maint', 'running', 'down']);
});

it('bounds frames to one sample per registered slot without mutating the input', () => {
  const input = frame(2, [
    sample('equipment-0', 1),
    sample('external-9', 2),
    sample('equipment-16', 2),
    sample('equipment-0', 3, 0.5),
    sample('equipment-5', 2),
    sample('equipment-5', 0),
  ]);
  const bounded = boundTelemetryFrame(input);
  expect(bounded.fabId).toBe('fab-a');
  expect(bounded.sequence).toBe(2);
  expect(bounded.capturedAt).toBe('2026-10-27T00:00:00Z');
  expect(bounded.samples).toEqual([sample('equipment-0', 1), sample('equipment-5', 2)]);
  expect(input.samples).toHaveLength(6);
});

it('merges frames by render slot: base order, incoming overrides, appended arrival order', () => {
  const base = frame(1, [sample('equipment-0', 0, 0.1), sample('equipment-2', 2)]);
  const incoming = frame(5, [
    sample('equipment-2', 3), // overrides in the base position
    sample('equipment-1', 1), // appended after base entities
    sample('equipment-1', 9), // duplicate after first occurrence ignored
  ], '2026-10-27T00:00:05Z');
  const merged = mergeTelemetryFrames(base, incoming);
  expect(merged.fabId).toBe('fab-a');
  expect(merged.sequence).toBe(5);
  expect(merged.capturedAt).toBe('2026-10-27T00:00:05Z');
  expect(merged.samples).toEqual([sample('equipment-0', 0, 0.1), sample('equipment-2', 3), sample('equipment-1', 1)]);
  // Pure and non-destructive: the input frames keep their own samples.
  expect(base.samples[1].values.state).toBe(2);
  expect(incoming.samples).toHaveLength(3);
});

it('drops unknown entity ids while merging so the pending frame stays bounded', () => {
  const unknown = Array.from({ length: 1_000 }, (_, index) => sample(`external-${index}`, 2));
  const base = frame(1, [sample('equipment-0', 1)]);
  const incoming = frame(2, [...unknown, sample('equipment-7', 2), sample('equipment-7', 0), sample('equipment-16', 2)]);
  const merged = mergeTelemetryFrames(base, incoming);
  expect(merged.samples.map((sample) => sample.entityId)).toEqual(['equipment-0', 'equipment-7']);
  expect(merged.samples[1].values.state).toBe(2);
});

it('stays a pure domain module: no UI, state container, router or transport imports', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../../src/domain/equipment-tool-state-projection.ts', import.meta.url)),
    'utf8',
  );
  const specifiers = [...source.matchAll(/(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g)].map((match) => match[1]);
  expect(specifiers.length).toBeGreaterThan(0);
  for (const specifier of specifiers) {
    expect(specifier).not.toMatch(/^(react|react-dom|@tanstack|zustand|xstate|@babylonjs)/);
    expect(specifier).not.toMatch(/realtime\//);
    expect(specifier).not.toMatch(/state\//);
  }
});
