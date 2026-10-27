import { FrameRingBuffer } from '../buffers/FrameRingBuffer';

export type TelemetryWorkerCommand =
  | { readonly type: 'frame'; readonly sequence: number; readonly values: ArrayLike<number>; readonly generation?: number }
  | { readonly type: 'snapshot' }
  | { readonly type: 'reset' };

export type TelemetryWorkerEvent =
  | { readonly type: 'frame-written'; readonly sequence: number; readonly dropped: number; readonly latest: number[]; readonly generation?: number }
  | { readonly type: 'snapshot'; readonly sequence: number; readonly values: number[] };

export interface TelemetryWorkerHandler {
  handle(command: unknown): TelemetryWorkerEvent | undefined;
  readonly buffer: FrameRingBuffer;
}

const isFrame = (value: unknown): value is Extract<TelemetryWorkerCommand, { type: 'frame' }> => {
  if (typeof value !== 'object' || value === null || (value as { type?: unknown }).type !== 'frame') return false;
  if (!Number.isInteger((value as { sequence?: unknown }).sequence)) return false;
  const frameValues = (value as { values?: unknown }).values;
  if (!Array.isArray(frameValues) && !ArrayBuffer.isView(frameValues)) return false;
  return Array.from(frameValues as ArrayLike<number>).every((entry) => typeof entry === 'number' && Number.isFinite(entry));
};

/**
 * Pure worker message handler, separated from the WorkerGlobalScope entry for
 * unit testing. It owns only a typed-array ring buffer and never touches React
 * or any application store.
 */
export function createTelemetryWorkerHandler(options: { capacity?: number; frameSize?: number } = {}): TelemetryWorkerHandler {
  const buffer = new FrameRingBuffer({ capacity: options.capacity ?? 256, frameSize: options.frameSize ?? 8 });
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
        return { type: 'frame-written', sequence, dropped: buffer.droppedFrames, latest: [...buffer.readLatest()!],
          ...(command.generation === undefined ? {} : { generation: command.generation }) };
      }
      if (type === 'snapshot') {
        const latest = buffer.readLatest();
        return latest ? { type: 'snapshot', sequence, values: [...latest] } : undefined;
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
