import type { TelemetryFrame } from '../../application/contracts/CommandEvents';
import type { FabToolState } from '../../fab-layout';
import { MessageDecoder } from '../protocol/MessageDecoder';
import { createTelemetryWorker } from '../workers/createTelemetryWorker';

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
const ENTITY_SLOT_PATTERN = /^equipment-(\d+)$/;

/**
 * Accept a Worker reply payload without copying on the product path: the Worker
 * replies with a Float32Array (binary structured clone) and that array becomes
 * the snapshot by reference. Plain arrays / other views are tolerated only for
 * compatibility with an older worker build and are converted once there.
 */
function workerFrameValues(payload: unknown): Float32Array | undefined {
  if (payload instanceof Float32Array) return payload;
  if (ArrayBuffer.isView(payload)) return Float32Array.from(payload as unknown as ArrayLike<number>);
  if (Array.isArray(payload)) return Float32Array.from(payload as number[]);
  return undefined;
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
  frame: TelemetryFrame,
  previous?: ArrayLike<number>,
): { sequence: number; values: Float32Array; toolStates: FabToolState[] } {
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
 *
 * At most one frame is in flight to the Worker at a time. Frames decoded while
 * a reply is outstanding replace a single pending slot (latest-wins) instead of
 * queueing, so a slow Worker can never grow an unbounded backlog; the pending
 * frame is submitted as soon as the current reply arrives.
 */
export class TelemetryRuntime {
  private source?: EventSourceLike;
  private worker?: WorkerLike;
  private snapshot?: TelemetrySnapshot;
  /** Last submitted slot-keyed frame; missing entities inherit these values. */
  private lastValues?: Float32Array;
  /** Newest decoded frame waiting for the in-flight Worker reply (latest-wins). */
  private pendingFrame?: TelemetryFrame;
  /** True between a frame postMessage and its `frame-written` reply. */
  private inFlight = false;
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
      (typeof Worker === 'undefined' ? undefined : () => createTelemetryWorker() as unknown as WorkerLike);
    if (!eventSourceFactory || !workerFactory) return;
    this.started = true;
    const decoder = new MessageDecoder();
    let generation = 0;
    let acceptedSequence = -1;
    try {
      const worker = workerFactory();
      this.worker = worker;
      // One typed-array allocation per *submitted* frame: postMessage
      // structured-clones it to the Worker, and the reply Float32Array becomes
      // the new snapshot by reference (no Float32Array.from on the main thread).
      const submit = (frame: TelemetryFrame) => {
        const flattened = flattenTelemetryFrame(frame, this.lastValues);
        this.lastValues = flattened.values;
        // Mark in flight before posting: a test/worker reply may be delivered
        // synchronously and only a reply may release the in-flight slot.
        this.inFlight = true;
        worker.postMessage({ type: 'frame', sequence: flattened.sequence, values: flattened.values, generation });
      };
      const flushPending = () => {
        const pending = this.pendingFrame;
        this.pendingFrame = undefined;
        if (pending) submit(pending);
      };
      worker.onmessage = (event) => {
        if (!this.started || this.worker !== worker) return;
        const data = event.data as { type?: string; sequence?: number; generation?: number; latest?: unknown } | undefined;
        if (!data || data.type !== 'frame-written' || typeof data.sequence !== 'number') return;
        // A reply from a previous SSE connection must not restore the old
        // watermark; its backend sequence belongs to the obsolete stream.
        if (data.generation !== generation) return;
        this.inFlight = false;
        const values = workerFrameValues(data.latest);
        if (values && (!this.snapshot || data.sequence > this.snapshot.sequence)) {
          // Store the reply typed array directly: the Worker already sent a copy.
          this.snapshot = { sequence: data.sequence, values, toolStates: toolStatesFromValues(values) };
        }
        flushPending();
      };
      const source = eventSourceFactory(this.options.url);
      this.source = source;
      source.onopen = () => {
        if (!this.started || this.source !== source) return;
        // Backend sequences are local to each SSE connection. Start a new
        // generation, reset the Worker watermark, and drop any frame still in
        // flight/pending from the closed connection.
        generation += 1;
        acceptedSequence = -1;
        this.snapshot = undefined;
        this.pendingFrame = undefined;
        this.inFlight = false;
        worker.postMessage({ type: 'reset' });
      };
      source.onmessage = (event) => {
        if (!this.started || this.source !== source) return;
        try {
          const decoded = decoder.decode(event.data);
          if (decoded.kind !== 'telemetry') return;
          // One runtime per FAB: a crossed frame must never enter this Worker.
          if (this.options.fabId !== undefined && decoded.event.fabId !== this.options.fabId) return;
          if (decoded.event.sequence <= acceptedSequence) return;
          acceptedSequence = decoded.event.sequence;
          // Latest-wins: while one frame awaits its reply, keep only the newest
          // decoded frame. Superseded frames are dropped (never queued); the
          // retained frame is slot-merged against the last submitted frame.
          if (this.inFlight) {
            this.pendingFrame = decoded.event;
            return;
          }
          submit(decoded.event);
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
    const source = this.source;
    const worker = this.worker;
    this.source = undefined;
    this.worker = undefined;
    this.snapshot = undefined;
    this.lastValues = undefined;
    this.pendingFrame = undefined;
    this.inFlight = false;
    this.started = false;
    // Detach first so a late SSE/Worker event cannot re-enter the runtime.
    if (source) {
      source.onopen = null;
      source.onmessage = null;
      source.close();
    }
    if (worker) {
      worker.onmessage = null;
      worker.terminate();
    }
  }

  /** Renderer frame-loop read; returns undefined until the first worker frame. */
  getToolStates(): readonly FabToolState[] | undefined {
    return this.snapshot?.toolStates;
  }

  getSnapshot(): TelemetrySnapshot | undefined {
    return this.snapshot;
  }
}
