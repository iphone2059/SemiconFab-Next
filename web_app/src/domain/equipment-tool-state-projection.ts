import type { FabToolState } from '@/domain/fab-layout';

/**
 * Pure FAB equipment-slot projection: decoder-validated telemetry frames in,
 * typed render frame and `FabToolState` list out.
 *
 * Responsibility split (P2, review finding 4.1):
 * - The telemetry transport (`realtime/telemetry/TelemetryRuntime.ts`) owns the
 *   SSE stream, the Worker round trip, wire sequence numbers, the single
 *   in-flight/pending slot, backpressure and reconnect/retry behavior. It hands
 *   this module only validated frames plus the previous projected buffer.
 * - This module owns the FAB device semantics: which entity ids address a
 *   render slot (`equipment-<0..15>`), how samples are packed into the fixed
 *   `[stateIndex, utilization] x 16` Float32 frame the Worker carries, how
 *   pending frames merge by slot, and how slot values decode back into
 *   `FabToolState`.
 *
 * Pure and self-contained: no React, Zustand, Router, SSE, Worker or renderer
 * imports; no mutation of caller frames or shared state.
 */

/** FAB equipment render slots carried by one telemetry frame (`equipment-0..15`). */
export const SAMPLE_LIMIT = 16;
/** Floats per projected frame: a state index and a utilization per slot. */
export const FRAME_SIZE = SAMPLE_LIMIT * 2;
/** Stable render-slot entity id format (`equipment-<index>`). */
export const ENTITY_SLOT_PATTERN = /^equipment-(\d+)$/;
/** Slot state index (the `state` sample value) to renderer tool state. */
export const TOOL_STATES: readonly FabToolState[] = ['running', 'idle', 'down', 'maint'];

/** One decoder-validated wire sample; the transport supplies it, this module interprets it. */
export interface TelemetryProjectionSample {
  readonly entityId: string;
  readonly values: Readonly<Record<string, number>>;
}

/** One decoder-validated wire frame; the transport supplies it, this module slots it. */
export interface TelemetryProjectionFrame {
  readonly fabId: string;
  readonly sequence: number;
  readonly capturedAt: string;
  readonly samples: readonly TelemetryProjectionSample[];
}

/** Fixed typed-array frame plus the decoded renderer states produced from one wire frame. */
export interface FlattenedTelemetryFrame {
  readonly sequence: number;
  readonly values: Float32Array;
  readonly toolStates: FabToolState[];
}

/**
 * Parse a telemetry entity id into its stable render slot. Sample array
 * position is NOT identity: the backend may reorder samples between frames.
 * Unknown entity ids (not `equipment-<index>` inside the 16-slot frame) have no
 * slot and are ignored.
 */
export function telemetrySlotForEntityId(entityId: string): number | undefined {
  const match = ENTITY_SLOT_PATTERN.exec(entityId);
  if (!match) return undefined;
  const slot = Number(match[1]);
  return Number.isSafeInteger(slot) && slot >= 0 && slot < SAMPLE_LIMIT ? slot : undefined;
}

/**
 * Flatten wire samples into the fixed Float32 frame consumed by the Worker.
 *
 * Slots are keyed by the stable entity index (`equipment-<index>`), so shuffled
 * sample arrays still update the same tool. Slots absent from this frame keep
 * their previous values instead of resetting to zero (= `running`); on the first
 * frame of a connection missing slots use the zero/running default. Duplicate
 * entity ids are ignored after their first occurrence.
 *
 * The returned values are a Float32Array so the Worker round trip is a binary
 * structured clone instead of a 32-entry number[] allocation + serialization.
 */
export function flattenTelemetryFrame(
  frame: TelemetryProjectionFrame,
  previous?: ArrayLike<number>,
): FlattenedTelemetryFrame {
  const values = new Float32Array(FRAME_SIZE);
  if (previous) {
    const inherited = Math.min(FRAME_SIZE, previous.length);
    for (let index = 0; index < inherited; index += 1) values[index] = Number(previous[index] ?? 0);
  }
  const touched = new Set<number>();
  for (const sample of frame.samples) {
    const slot = telemetrySlotForEntityId(sample.entityId);
    if (slot === undefined || touched.has(slot)) continue;
    touched.add(slot);
    const state = Math.max(0, Math.min(TOOL_STATES.length - 1, Math.round(sample.values.state ?? 0)));
    const utilization = Math.max(0, Math.min(1, sample.values.utilization ?? 0));
    values[slot * 2] = state;
    values[slot * 2 + 1] = utilization;
  }
  return { sequence: frame.sequence, values, toolStates: toolStatesFromValues(values) };
}

/**
 * Bound one raw frame to at most one sample per registered render slot.
 * Unknown/out-of-range entity ids and duplicate slots after their first
 * occurrence are dropped; sample order is preserved. Returns a new frame;
 * neither the input frame nor its samples are mutated.
 */
export function boundTelemetryFrame(frame: TelemetryProjectionFrame): TelemetryProjectionFrame {
  const seen = new Set<number>();
  const samples: TelemetryProjectionSample[] = [];
  for (const sample of frame.samples) {
    const slot = telemetrySlotForEntityId(sample.entityId);
    if (slot === undefined || seen.has(slot)) continue;
    seen.add(slot);
    samples.push(sample);
  }
  return { fabId: frame.fabId, sequence: frame.sequence, capturedAt: frame.capturedAt, samples };
}

/**
 * Merge a later telemetry frame into an earlier one by render-slot identity.
 *
 * The protocol sends full snapshots today, but a sparse/delta frame only
 * carries the entities that changed. During Worker backpressure the runtime
 * keeps exactly one pending frame; merging rather than replacing it preserves
 * every registered entity's update while keeping the bounded latest-wins slot:
 * - only entity ids with a registered render slot (`equipment-0..15`) are kept:
 *   unknown ids cannot be rendered and must not grow the pending object;
 * - samples keep the base frame order; one sample per slot remains;
 * - a sample for the same slot is overridden by the incoming one;
 * - slots that only appear in the incoming frame are appended in arrival order
 *   (duplicates after the first occurrence are ignored);
 * - `fabId`/`sequence`/`capturedAt` describe the newest (incoming) frame.
 *
 * Pure: neither input frame nor its samples are mutated.
 */
export function mergeTelemetryFrames(
  base: TelemetryProjectionFrame,
  incoming: TelemetryProjectionFrame,
): TelemetryProjectionFrame {
  const incomingBySlot = new Map<number, TelemetryProjectionSample>();
  for (const sample of incoming.samples) {
    const slot = telemetrySlotForEntityId(sample.entityId);
    if (slot === undefined || incomingBySlot.has(slot)) continue;
    incomingBySlot.set(slot, sample);
  }
  const merged: TelemetryProjectionSample[] = [];
  const seen = new Set<number>();
  for (const sample of base.samples) {
    const slot = telemetrySlotForEntityId(sample.entityId);
    if (slot === undefined || seen.has(slot)) continue;
    seen.add(slot);
    merged.push(incomingBySlot.get(slot) ?? sample);
  }
  for (const [slot, sample] of incomingBySlot) {
    if (seen.has(slot)) continue;
    seen.add(slot);
    merged.push(sample);
  }
  return { fabId: incoming.fabId, sequence: incoming.sequence, capturedAt: incoming.capturedAt, samples: merged };
}

/** Map worker-returned Float32 values back to renderer tool states. */
export function toolStatesFromValues(values: ArrayLike<number>): FabToolState[] {
  const states: FabToolState[] = [];
  for (let index = 0; index < SAMPLE_LIMIT; index += 1) {
    const state = Math.max(0, Math.min(TOOL_STATES.length - 1, Math.round(values[index * 2] ?? 0)));
    states.push(TOOL_STATES[state]);
  }
  return states;
}
