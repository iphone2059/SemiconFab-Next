import type { TelemetryFrame } from '../../application/contracts/CommandEvents';
import type { FabToolState } from '../../fab-layout';
import { MessageDecoder } from '../protocol/MessageDecoder';

interface EventSourceLike {
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  close(): void;
}

interface WorkerLike {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage(message: unknown): void;
  terminate(): void;
}

export interface TelemetryRuntimeOptions {
  readonly url: string;
  /** FAB identity for the scoped stream; frames for another FAB are rejected. */
  readonly fabId?: string;
  /** Test seam; production defaults to browser EventSource. */
  readonly eventSourceFactory?: (url: string) => EventSourceLike;
  /** Test seam; production defaults to a module Worker. */
  readonly workerFactory?: () => WorkerLike;
}

export interface TelemetrySnapshot {
  readonly sequence: number;
  readonly values: Float32Array;
  readonly toolStates: readonly FabToolState[];
}

const TOOL_STATES: readonly FabToolState[] = ['running', 'idle', 'down', 'maint'];
const SAMPLE_LIMIT = 16;
const FRAME_SIZE = SAMPLE_LIMIT * 2;

/** Flatten wire samples into the fixed Float32 frame consumed by the Worker. */
export function flattenTelemetryFrame(frame: TelemetryFrame): { sequence: number; values: number[]; toolStates: FabToolState[] } {
  const sampleCount = Math.min(frame.samples.length, SAMPLE_LIMIT);
  const values: number[] = [];
  const toolStates: FabToolState[] = [];
  for (let index = 0; index < sampleCount; index += 1) {
    const valuesAtSample = frame.samples[index].values;
    const state = Math.max(0, Math.min(TOOL_STATES.length - 1, Math.round(valuesAtSample.state ?? 0)));
    const utilization = Math.max(0, Math.min(1, valuesAtSample.utilization ?? 0));
    values.push(state, utilization);
    toolStates.push(TOOL_STATES[state]);
  }
  while (values.length < FRAME_SIZE) values.push(0);
  return { sequence: frame.sequence, values, toolStates };
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

/**
 * Product telemetry path: backend SSE -> decoder -> module Worker ->
 * FrameRingBuffer -> latest typed frame. The renderer polls
 * getToolStates() inside its frame loop; this object never goes through React,
 * Query, Zustand or XState (ARCH-11).
 */
export class TelemetryRuntime {
  private source?: EventSourceLike;
  private worker?: WorkerLike;
  private snapshot?: TelemetrySnapshot;
  private started = false;

  constructor(private readonly options: TelemetryRuntimeOptions) {}

  get fabId(): string | undefined {
    return this.options.fabId;
  }

  start(): void {
    if (this.started) return;
    const eventSourceFactory = this.options.eventSourceFactory ??
      (typeof EventSource === 'undefined' ? undefined : (target: string) => new EventSource(target) as unknown as EventSourceLike);
    const workerFactory = this.options.workerFactory ??
      (typeof Worker === 'undefined' ? undefined : () => new Worker(new URL('../workers/telemetryWorker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike);
    if (!eventSourceFactory || !workerFactory) return;
    this.started = true;
    const decoder = new MessageDecoder();
    let generation = 0;
    let submittedSequence = -1;
    try {
      const worker = workerFactory();
      this.worker = worker;
      worker.onmessage = (event) => {
        if (!this.started || this.worker !== worker) return;
        const data = event.data as { type?: string; sequence?: number; generation?: number; latest?: number[] } | undefined;
        if (!data || data.type !== 'frame-written' || typeof data.sequence !== 'number' || !Array.isArray(data.latest)) return;
        if (data.generation !== generation) return;
        if (this.snapshot && data.sequence <= this.snapshot.sequence) return;
        const values = Float32Array.from(data.latest);
        this.snapshot = { sequence: data.sequence, values, toolStates: toolStatesFromValues(values) };
      };
      const source = eventSourceFactory(this.options.url);
      this.source = source;
      source.onopen = () => {
        if (!this.started || this.source !== source) return;
        // Backend sequences are local to each SSE connection. Tag Worker
        // replies so an old in-flight response cannot restore the old watermark.
        generation += 1;
        submittedSequence = -1;
        this.snapshot = undefined;
        worker.postMessage({ type: 'reset' });
      };
      source.onmessage = (event) => {
        if (!this.started || this.source !== source) return;
        try {
          const decoded = decoder.decode(event.data);
          if (decoded.kind !== 'telemetry') return;
          // One runtime per FAB: a crossed frame must never enter this Worker.
          if (this.options.fabId !== undefined && decoded.event.fabId !== this.options.fabId) return;
          const frame = flattenTelemetryFrame(decoded.event);
          if (frame.sequence <= submittedSequence) return;
          worker.postMessage({ type: 'frame', sequence: frame.sequence, values: frame.values, generation });
          submittedSequence = frame.sequence;
        } catch {
          // Ignore malformed frames; the next authoritative frame converges.
        }
      };
    } catch {
      this.started = false;
      this.stop();
    }
  }

  stop(): void {
    this.source?.close();
    this.worker?.terminate();
    this.source = undefined;
    this.worker = undefined;
    this.snapshot = undefined;
    this.started = false;
  }

  /** Renderer frame-loop read; returns undefined until the first worker frame. */
  getToolStates(): readonly FabToolState[] | undefined {
    return this.snapshot?.toolStates;
  }

  getSnapshot(): TelemetrySnapshot | undefined {
    return this.snapshot;
  }
}
