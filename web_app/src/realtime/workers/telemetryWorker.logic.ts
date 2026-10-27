import { FrameRingBuffer } from '../buffers/FrameRingBuffer';

export type TelemetryWorkerCommand =
  | { readonly type: 'frame'; readonly sequence: number; readonly values: readonly number[] }
  | { readonly type: 'snapshot' }
  | { readonly type: 'reset' };

export type TelemetryWorkerEvent =
  | { readonly type: 'frame-written'; readonly sequence: number; readonly dropped: number }
  | { readonly type: 'snapshot'; readonly sequence: number; readonly values: number[] };

export interface TelemetryWorkerHandler {
  handle(command: unknown): TelemetryWorkerEvent | undefined;
  readonly buffer: FrameRingBuffer;
}

const isFrame = (value: unknown): value is { type: 'frame'; sequence: number; values: number[] } =>
  typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'frame' &&
  Number.isInteger((value as { sequence?: unknown }).sequence) &&
  Array.isArray((value as { values?: unknown }).values) &&
  ((value as { values: unknown[] }).values).every((entry) => typeof entry === 'number' && Number.isFinite(entry));

/**
 * Pure worker message handler, separated from the WorkerGlobalScope entry for
 * unit testing. It owns only a typed-array ring buffer and never touches React
 * or any application store.
 */
export function createTelemetryWorkerHandler(options: { capacity?: number; frameSize?: number } = {}): TelemetryWorkerHandler {
  const buffer = new FrameRingBuffer({ capacity: options.capacity ?? 256, frameSize: options.frameSize ?? 8 });
  return {
    buffer,
    handle: (command: unknown): TelemetryWorkerEvent | undefined => {
      if (!command || typeof command !== 'object') return undefined;
      const type = (command as { type?: unknown }).type;
      if (type === 'frame') {
        if (!isFrame(command) || command.values.length !== buffer.frameSize) return undefined;
        const sequence = buffer.write(command.values);
        return { type: 'frame-written', sequence, dropped: buffer.droppedFrames };
      }
      if (type === 'snapshot') {
        const latest = buffer.readLatest();
        return latest ? { type: 'snapshot', sequence: buffer.latestSequence, values: [...latest] } : undefined;
      }
      if (type === 'reset') {
        buffer.reset();
        return undefined;
      }
      return undefined;
    },
  };
}
