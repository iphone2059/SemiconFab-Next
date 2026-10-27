import type { TelemetryFrame, TelemetrySample } from '../../application/contracts/CommandEvents';
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
  onerror?: ((event: unknown) => void) | null;
  onmessageerror?: ((event: unknown) => void) | null;
  postMessage(message: unknown): void;
  terminate(): void;
}

/** Observable Worker health; the renderer may show a stale/down indicator. */
export type TelemetryRuntimeStatus = 'stopped' | 'idle' | 'live' | 'stale';

export interface TelemetryRuntimeOptions {
  readonly url: string;
  /** FAB identity for the scoped stream; frames for another FAB are rejected. */
  readonly fabId?: string;
  /** Test seam; production defaults to browser EventSource. */
  readonly eventSourceFactory?: (url: string) => EventSourceLike;
  /** Test seam; production defaults to a module Worker. */
  readonly workerFactory?: () => WorkerLike;
  /** In-flight Worker reply timeout before the slot is released and rebuilt (0 disables). */
  readonly workerTimeoutMs?: number;
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
/** Default in-flight ceiling: a healthy Worker replies in microseconds; 2s only catches a wedged one. */
const DEFAULT_WORKER_TIMEOUT_MS = 2_000;

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

/** Bound one raw frame to at most one sample per registered render slot. */
function boundTelemetryFrame(frame: TelemetryFrame): TelemetryFrame {
  const seen = new Set<number>();
  const samples: TelemetrySample[] = [];
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
export function mergeTelemetryFrames(base: TelemetryFrame, incoming: TelemetryFrame): TelemetryFrame {
  const incomingBySlot = new Map<number, TelemetrySample>();
  for (const sample of incoming.samples) {
    const slot = telemetrySlotForEntityId(sample.entityId);
    if (slot === undefined || incomingBySlot.has(slot)) continue;
    incomingBySlot.set(slot, sample);
  }
  const merged: TelemetrySample[] = [];
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

/**
 * Product telemetry path: backend SSE -> decoder -> module Worker ->
 * FrameRingBuffer -> latest typed frame. The renderer polls
 * getToolStates() inside its frame loop; this object never goes through React,
 * Query, Zustand or XState (ARCH-11).
 *
 * At most one frame is in flight to the Worker at a time. Frames decoded while
 * a reply is outstanding are merged by render-slot into a single pending slot
 * (bounded latest-wins) instead of being queued or replaced: full snapshots
 * still converge to the newest frame, while sparse/delta frames cannot lose
 * registered entity updates. The pending frame is submitted as soon as the
 * reply arrives.
 *
 * Worker failure recovery: a Worker error/messageerror event or an in-flight
 * reply timeout releases the slot, marks the runtime stale (observable via
 * `status`/`stale`) and rebuilds a new Worker generation; a synchronous
 * postMessage throw rolls the slot back without wedging the pipeline. Generation
 * checks still drop replies from an obsolete Worker/SSE connection.
 */
export class TelemetryRuntime {
  private source?: EventSourceLike;
  private worker?: WorkerLike;
  private snapshot?: TelemetrySnapshot;
  /** Last submitted slot-keyed frame; missing entities inherit these values. */
  private lastValues?: Float32Array;
  /** Bounded latest-wins slot: decoded frames merged while the Worker reply is outstanding. */
  private pendingFrame?: TelemetryFrame;
  /** True between a frame postMessage and its `frame-written` reply. */
  private inFlight = false;
  private started = false;
  private statusValue: TelemetryRuntimeStatus = 'stopped';
  private workerFailed = false;
  private inFlightTimer?: ReturnType<typeof setTimeout>;
  private readonly workerTimeoutMs: number;

  constructor(private readonly options: TelemetryRuntimeOptions) {
    this.workerTimeoutMs = Math.max(0, options.workerTimeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS);
  }

  get fabId(): string | undefined {
    return this.options.fabId;
  }

  /** Observable health: 'stale' once a Worker fault released the slot until a valid frame applies. */
  get status(): TelemetryRuntimeStatus {
    return this.statusValue;
  }

  /** True while the last Worker reply is overdue/failed and the snapshot may be stale. */
  get stale(): boolean {
    return this.statusValue === 'stale';
  }

  /** True when rebuilding the Worker itself failed (no Worker is installed). */
  get failed(): boolean {
    return this.workerFailed;
  }

  start(): void {
    if (this.started) return;
    const eventSourceFactory = this.options.eventSourceFactory ??
      (typeof EventSource === 'undefined' ? undefined : (target: string) => new EventSource(target) as unknown as EventSourceLike);
    const workerFactory = this.options.workerFactory ??
      (typeof Worker === 'undefined' ? undefined : () => createTelemetryWorker() as unknown as WorkerLike);
    if (!eventSourceFactory || !workerFactory) return;
    this.started = true;
    this.statusValue = 'idle';
    this.workerFailed = false;
    const decoder = new MessageDecoder();
    let generation = 0;
    let acceptedSequence = -1;
    let rebuilding = false;

    const clearInFlightTimeout = (): void => {
      if (this.inFlightTimer === undefined) return;
      clearTimeout(this.inFlightTimer);
      this.inFlightTimer = undefined;
    };

    const armInFlightTimeout = (): void => {
      clearInFlightTimeout();
      if (this.workerTimeoutMs <= 0) return;
      this.inFlightTimer = setTimeout(() => {
        this.inFlightTimer = undefined;
        onWorkerFailure();
      }, this.workerTimeoutMs);
    };

    const submit = (frame: TelemetryFrame): void => {
      const worker = this.worker;
      if (!worker) {
        // No usable Worker: keep one bounded pending frame so a later rebuild
        // can flush the newest decoded state instead of silently dropping it.
        this.pendingFrame = boundTelemetryFrame(frame);
        this.statusValue = 'stale';
        return;
      }
      const flattened = flattenTelemetryFrame(frame, this.lastValues);
      this.lastValues = flattened.values;
      // Mark in flight before posting: a test/worker reply may be delivered
      // synchronously and only a reply may release the in-flight slot.
      this.inFlight = true;
      armInFlightTimeout();
      try {
        worker.postMessage({ type: 'frame', sequence: flattened.sequence, values: flattened.values, generation });
      } catch {
        // Synchronous postMessage failure: roll the in-flight slot back, retain
        // the frame in the bounded pending slot and rebuild the Worker.
        this.inFlight = false;
        clearInFlightTimeout();
        this.pendingFrame = this.pendingFrame
          ? mergeTelemetryFrames(this.pendingFrame, frame)
          : boundTelemetryFrame(frame);
        this.statusValue = 'stale';
        rebuildWorker();
        return;
      }
      if (this.statusValue !== 'stale') this.statusValue = 'live';
    };

    const flushPending = (): void => {
      const pending = this.pendingFrame;
      this.pendingFrame = undefined;
      if (pending) submit(pending);
    };

    const onWorkerFailure = (): void => {
      if (!this.started) return;
      // A failed/timed-out Worker never releases the slot on its own, so release
      // it here and swap in a fresh generation instead of waiting forever.
      this.inFlight = false;
      clearInFlightTimeout();
      this.statusValue = 'stale';
      rebuildWorker();
      if (this.worker) flushPending();
    };

    const attachWorker = (worker: WorkerLike): void => {
      worker.onmessage = (event) => {
        if (!this.started || this.worker !== worker) return;
        const data = event.data as { type?: string; sequence?: number; generation?: number; latest?: unknown } | undefined;
        if (!data || data.type !== 'frame-written' || typeof data.sequence !== 'number') return;
        // A reply from a previous SSE connection / Worker generation must not
        // restore the old watermark; its backend sequence belongs to the
        // obsolete stream.
        if (data.generation !== generation) return;
        this.inFlight = false;
        clearInFlightTimeout();
        this.workerFailed = false;
        this.statusValue = 'live';
        const values = workerFrameValues(data.latest);
        if (values && (!this.snapshot || data.sequence > this.snapshot.sequence)) {
          // Store the reply typed array directly: the Worker already sent a copy.
          this.snapshot = { sequence: data.sequence, values, toolStates: toolStatesFromValues(values) };
        }
        flushPending();
      };
      worker.onerror = () => {
        if (!this.started || this.worker !== worker) return;
        onWorkerFailure();
      };
      worker.onmessageerror = () => {
        if (!this.started || this.worker !== worker) return;
        onWorkerFailure();
      };
    };

    const rebuildWorker = (): void => {
      if (rebuilding) return;
      rebuilding = true;
      try {
        const previous = this.worker;
        this.worker = undefined;
        if (previous) {
          previous.onmessage = null;
          previous.onerror = null;
          previous.onmessageerror = null;
          previous.terminate();
        }
        // Always advance the generation so late replies from the failed Worker
        // are ignored by the generation check above.
        generation += 1;
        let replacement: WorkerLike;
        try {
          replacement = workerFactory();
        } catch {
          this.workerFailed = true;
          this.statusValue = 'stale';
          return;
        }
        this.worker = replacement;
        this.workerFailed = false;
        attachWorker(replacement);
        try {
          replacement.postMessage({ type: 'reset' });
        } catch {
          this.workerFailed = true;
          this.statusValue = 'stale';
        }
      } finally {
        rebuilding = false;
      }
    };

    try {
      const worker = workerFactory();
      this.worker = worker;
      attachWorker(worker);
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
        clearInFlightTimeout();
        this.statusValue = 'idle';
        if (this.worker) {
          try {
            this.worker.postMessage({ type: 'reset' });
          } catch {
            this.statusValue = 'stale';
          }
        }
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
          // Bounded latest-wins with delta-safe merge: while one frame awaits its
          // reply, merge the newer decoded frame into the single pending slot
          // (no queue). Full snapshots keep the newest values; sparse/delta
          // frames never lose the registered entity updates decoded in between.
          if (this.inFlight) {
            this.pendingFrame = this.pendingFrame
              ? mergeTelemetryFrames(this.pendingFrame, decoded.event)
              : boundTelemetryFrame(decoded.event);
            return;
          }
          if (this.pendingFrame) {
            // A previous submit failed/became stale: converge the held updates
            // together with this newer frame instead of dropping them.
            const merged = mergeTelemetryFrames(this.pendingFrame, decoded.event);
            this.pendingFrame = undefined;
            submit(merged);
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
    this.statusValue = 'stopped';
    this.workerFailed = false;
    if (this.inFlightTimer !== undefined) {
      clearTimeout(this.inFlightTimer);
      this.inFlightTimer = undefined;
    }
    // Detach first so a late SSE/Worker event cannot re-enter the runtime.
    if (source) {
      source.onopen = null;
      source.onmessage = null;
      source.close();
    }
    if (worker) {
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
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
