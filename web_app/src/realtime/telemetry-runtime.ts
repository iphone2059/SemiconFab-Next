import type { TelemetryFrame } from '@/contracts/command-events.contract';
import {
  boundTelemetryFrame,
  flattenTelemetryFrame,
  mergeTelemetryFrames,
  toolStatesFromValues,
} from '@/domain/equipment-tool-state-projection';
import type { FabToolState } from '@/domain/fab-layout';
import { MessageDecoder } from '@/realtime/message-decoder';
import { createTelemetryWorker } from '@/realtime/telemetry-worker-factory';

// The pure slot/FabToolState projection lives in domain/equipment; the runtime
// re-exports the helpers it exposed before the split so callers stay unchanged.
export {
  flattenTelemetryFrame,
  mergeTelemetryFrames,
  telemetrySlotForEntityId,
  toolStatesFromValues,
} from '@/domain/equipment-tool-state-projection';

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
  /** Site that owns this FAB; part of the immutable composite runtime identity (R5.4-03). */
  readonly siteId: string;
  /** FAB identity for the scoped stream; frames for another FAB are rejected. */
  readonly fabId: string;
  /**
   * Site-scoped telemetry stream URL, built by the composition root from the same
   * identity: `/api/v1/sites/{siteId}/fabs/{fabId}/telemetry/stream`. The runtime
   * never derives or repairs it, so a runtime can never be paired with a stream of
   * another site. The frame wire schema carries no siteId: isolation comes from the
   * URL plus this per-runtime identity.
   */
  readonly url: string;
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
  private retryTimer?: ReturnType<typeof setTimeout>;
  private inFlightFrame?: TelemetryFrame;
  private readonly workerTimeoutMs: number;

  constructor(private readonly options: TelemetryRuntimeOptions) {
    this.workerTimeoutMs = Math.max(0, options.workerTimeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS);
  }

  /** Immutable composite identity of this runtime; part of every registry key. */
  get siteId(): string {
    return this.options.siteId;
  }

  get fabId(): string {
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
    let retryDelayMs = 250;
    let immediateRebuildAvailable = true;

    const scheduleRetry = (): void => {
      if (!this.started || this.retryTimer !== undefined) return;
      this.retryTimer = setTimeout(() => {
        this.retryTimer = undefined;
        if (!this.started) return;
        if (!this.worker) rebuildWorker();
        if (this.worker && !this.inFlight) flushPending();
      }, retryDelayMs);
      retryDelayMs = Math.min(8_000, retryDelayMs * 2);
    };

    const retireWorker = (): void => {
      const previous = this.worker;
      this.worker = undefined;
      generation += 1;
      if (!previous) return;
      previous.onmessage = null;
      previous.onerror = null;
      previous.onmessageerror = null;
      previous.terminate();
    };

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
        this.pendingFrame = this.pendingFrame
          ? mergeTelemetryFrames(this.pendingFrame, frame)
          : boundTelemetryFrame(frame);
        this.statusValue = 'stale';
        scheduleRetry();
        return;
      }
      const flattened = flattenTelemetryFrame(frame, this.lastValues);
      this.lastValues = flattened.values;
      // Mark in flight before posting: a test/worker reply may be delivered
      // synchronously and only a reply may release the in-flight slot.
      this.inFlight = true;
      this.inFlightFrame = boundTelemetryFrame(frame);
      armInFlightTimeout();
      try {
        worker.postMessage({ type: 'frame', sequence: flattened.sequence, values: flattened.values, generation });
      } catch {
        // Synchronous postMessage failure: roll the in-flight slot back, retain
        // the frame in the bounded pending slot and rebuild the Worker.
        onWorkerFailure(false);
        scheduleRetry();
        return;
      }
      if (this.statusValue !== 'stale') this.statusValue = 'live';
    };

    const flushPending = (): void => {
      const pending = this.pendingFrame;
      this.pendingFrame = undefined;
      if (pending) submit(pending);
    };

    const onWorkerFailure = (flushAfterRebuild = true): void => {
      if (!this.started) return;
      // A failed/timed-out Worker never releases the slot on its own, so release
      // it here and swap in a fresh generation instead of waiting forever.
      this.inFlight = false;
      const failedFrame = this.inFlightFrame;
      this.inFlightFrame = undefined;
      clearInFlightTimeout();
      this.statusValue = 'stale';
      if (immediateRebuildAvailable) {
        rebuildWorker();
        // Always retain the unanswered frame in the bounded pending slot: a healthy
        // replacement must replay it even when no newer SSE frame arrives, otherwise
        // the last decoded update is lost and the runtime stays stale until the next
        // frame. Merging with a newer pending frame keeps the newest value per render
        // slot (and that frame's sequence), so the replay cannot regress or duplicate
        // state; if allocation failed it stays pending for the retry as before.
        if (failedFrame) {
          this.pendingFrame = this.pendingFrame
            ? mergeTelemetryFrames(failedFrame, this.pendingFrame)
            : boundTelemetryFrame(failedFrame);
        }
        if (this.worker && flushAfterRebuild) flushPending();
      } else {
        if (failedFrame) this.pendingFrame = this.pendingFrame
          ? mergeTelemetryFrames(failedFrame, this.pendingFrame)
          : boundTelemetryFrame(failedFrame);
        retireWorker();
        this.workerFailed = true;
        scheduleRetry();
      }
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
        this.inFlightFrame = undefined;
        clearInFlightTimeout();
        this.workerFailed = false;
        this.statusValue = 'live';
        immediateRebuildAvailable = true;
        retryDelayMs = 250;
        if (this.retryTimer !== undefined) {
          clearTimeout(this.retryTimer);
          this.retryTimer = undefined;
        }
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
      immediateRebuildAvailable = false;
      try {
        retireWorker();
        let replacement: WorkerLike;
        try {
          replacement = workerFactory();
        } catch {
          this.workerFailed = true;
          this.statusValue = 'stale';
          scheduleRetry();
          return;
        }
        this.worker = replacement;
        this.workerFailed = false;
        attachWorker(replacement);
        try {
          replacement.postMessage({ type: 'reset' });
        } catch {
          retireWorker();
          this.workerFailed = true;
          this.statusValue = 'stale';
          scheduleRetry();
        }
      } finally {
        rebuilding = false;
      }
    };

    try {
      try {
        const worker = workerFactory();
        this.worker = worker;
        attachWorker(worker);
      } catch {
        this.workerFailed = true;
        this.statusValue = 'stale';
        immediateRebuildAvailable = false;
        scheduleRetry();
      }
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
        this.inFlightFrame = undefined;
        clearInFlightTimeout();
        this.statusValue = this.worker ? 'idle' : 'stale';
        if (this.worker) {
          try {
            this.worker.postMessage({ type: 'reset' });
          } catch {
            onWorkerFailure();
          }
        }
      };
      source.onmessage = (event) => {
        if (!this.started || this.source !== source) return;
        try {
          const decoded = decoder.decode(event.data);
          if (decoded.kind !== 'telemetry') return;
          // One runtime per (siteId, fabId): the site-scoped URL isolates the stream and
          // a crossed FAB frame must never enter this Worker. Frames carry no siteId
          // (wire schema unchanged), so the URL + runtime identity prove the site.
          if (decoded.event.fabId !== this.options.fabId) return;
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
    this.inFlightFrame = undefined;
    this.started = false;
    this.statusValue = 'stopped';
    this.workerFailed = false;
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
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
    return this.stale ? undefined : this.snapshot?.toolStates;
  }

  getSnapshot(): TelemetrySnapshot | undefined {
    return this.snapshot;
  }
}
