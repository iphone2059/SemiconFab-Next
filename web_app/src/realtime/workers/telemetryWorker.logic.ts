import { FrameRingBuffer } from '../buffers/FrameRingBuffer';

export type TelemetryWorkerCommand =
  | { readonly type: 'frame'; readonly sequence: number; readonly values: ArrayLike<number>; readonly generation?: number }
  | { readonly type: 'snapshot' }
  | { readonly type: 'reset' };

/**
 * Worker replies carry typed arrays: a Float32Array is a binary structured
 * clone across the thread boundary, while the old number[] reply allocated and
 * copied a fresh JavaScript array on every frame.
 */
export type TelemetryWorkerEvent =
  | { readonly type: 'frame-written'; readonly sequence: number; readonly dropped: number; readonly latest: Float32Array; readonly generation?: number }
  | { readonly type: 'snapshot'; readonly sequence: number; readonly values: Float32Array };

export interface TelemetryWorkerHandler {
  handle(command: unknown): TelemetryWorkerEvent | undefined;
  readonly buffer: FrameRingBuffer;
}

/**
 * The product worker is only ever read through readLatest(), so a deep frame
 * history is dead weight: the default ring keeps a short burst window instead
 * of 256 frames. At the largest stress frame (5,000 entities = 10,000 floats)
 * that is ~0.3 MB instead of ~10 MB. Callers that need real history (tests,
 * benchmarks) can still pass an explicit capacity.
 */
export const TELEMETRY_RING_CAPACITY = 8;

const isFrame = (value: unknown): value is Extract<TelemetryWorkerCommand, { type: 'frame' }> => {
  if (typeof value !== 'object' || value === null || (value as { type?: unknown }).type !== 'frame') return false;
  if (!Number.isInteger((value as { sequence?: unknown }).sequence)) return false;
  const frameValues = (value as { values?: unknown }).values;
  if (!Array.isArray(frameValues) && !ArrayBuffer.isView(frameValues)) return false;
  // Validate in place: Array.from would copy the whole frame before checking it.
  const values = frameValues as ArrayLike<number>;
  for (let index = 0; index < values.length; index += 1) {
    const entry = values[index];
    if (typeof entry !== 'number' || !Number.isFinite(entry)) return false;
  }
  return true;
};

/**
 * Pure worker message handler, separated from the WorkerGlobalScope entry for
 * unit testing. It owns only a typed-array ring buffer and never touches React
 * or any application store. Replies expose the ring's latest-frame copy as a
 * Float32Array so the runtime can store it without another conversion.
 */
export function createTelemetryWorkerHandler(options: { capacity?: number; frameSize?: number } = {}): TelemetryWorkerHandler {
  const buffer = new FrameRingBuffer({ capacity: options.capacity ?? TELEMETRY_RING_CAPACITY, frameSize: options.frameSize ?? 8 });
  let sequence = -1;
  return {
    buffer,
    handle: (command: unknown): TelemetryWorkerEvent | undefined => {
      if (!command || typeof command !== 'object') return undefined;
      const type = (command as { type?: unknown }).type;
      if (type === 'frame') {
        if (!isFrame(command) || command.values.length !== buffer.frameSize) return undefined;
        if (command.sequence <= sequence) return undefined;
        buffer.write(command.values);
        sequence = command.sequence;
        // readLatest() returns a fresh Float32Array copy, which postMessage then
        // structured-clones back to the runtime without an intermediate number[].
        return { type: 'frame-written', sequence, dropped: buffer.droppedFrames, latest: buffer.readLatest()!,
          ...(command.generation === undefined ? {} : { generation: command.generation }) };
      }
      if (type === 'snapshot') {
        const latest = buffer.readLatest();
        return latest ? { type: 'snapshot', sequence, values: latest } : undefined;
      }
      if (type === 'reset') {
        buffer.reset();
        sequence = -1;
        return undefined;
      }
      return undefined;
    },
  };
}
