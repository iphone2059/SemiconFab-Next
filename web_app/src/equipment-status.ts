export type EquipmentStateCode = 'running' | 'idle' | 'down' | 'maint';

export interface EquipmentStatusItem {
  readonly state: string;
}

export interface EquipmentStatusSnapshot {
  readonly siteId: string;
  /** FAB identity of a FAB-scoped snapshot (additive; absent on legacy site frames). */
  readonly fabId?: string;
  /**
   * Display time only. Ordering uses (epoch, sequence); a newer server
   * generation may legitimately report an older `generatedAt` first.
   */
  readonly generatedAt: string;
  /** Monotonic per-FAB tick. Optional for backward compatibility with older servers. */
  readonly sequence?: number;
  /**
   * Server generation, bumped whenever the backend restarts its status feed.
   * Ordering is (epoch, sequence): a higher epoch resets the ordering high-water
   * mark, a lower epoch is a stale frame from an older server generation.
   *
   * The backend must emit this field for restart-safe ordering. When it is
   * absent the legacy (sequence, timestamp) rules apply unchanged.
   */
  readonly epoch?: number;
  readonly tools: EquipmentStatusItem[];
}

/** Composite identity for FAB-scoped equipment status: REST + SSE must agree. */
export interface EquipmentStatusScope {
  readonly siteId: string;
  readonly fabId: string;
}

function isInScope(value: Partial<EquipmentStatusSnapshot>, scope: EquipmentStatusScope): boolean {
  // FAB identity is validated whenever the server sends it; legacy site-level
  // frames without fabId stay readable so an older backend does not blank the page.
  return value.siteId === scope.siteId && (value.fabId === undefined || value.fabId === scope.fabId);
}

function isSafeCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isValidSnapshot(
  value: unknown,
  scope: EquipmentStatusScope,
  expectedToolCount: number,
): value is EquipmentStatusSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const snapshot = value as Partial<EquipmentStatusSnapshot>;
  if (!isInScope(snapshot, scope) || typeof snapshot.generatedAt !== 'string' ||
      !Number.isFinite(Date.parse(snapshot.generatedAt))) return false;
  if (snapshot.sequence !== undefined && !isSafeCount(snapshot.sequence)) return false;
  if (snapshot.epoch !== undefined && !isSafeCount(snapshot.epoch)) return false;
  if (!Array.isArray(snapshot.tools) || snapshot.tools.length !== expectedToolCount) return false;
  return snapshot.tools.every(tool =>
    tool !== null && typeof tool === 'object' &&
    (tool.state === 'running' || tool.state === 'idle' ||
     tool.state === 'down' || tool.state === 'maint'));
}

/** Keep the last good snapshot visible, but never label a disconnected/stalled stream LIVE. */
export function watchEquipmentStatus(
  source: EventSource,
  scope: EquipmentStatusScope,
  onSnapshot: (snapshot: EquipmentStatusSnapshot) => void,
  onStale: () => void,
  signal: AbortSignal,
): void {
  if (signal.aborted) { source.close(); return; }
  let lastValidFrame = Date.now();
  const timer = setInterval(() => { if (Date.now() - lastValidFrame >= 12000) onStale(); }, 4000);
  source.onerror = () => { if (!signal.aborted) onStale(); };
  source.onmessage = event => {
    if (signal.aborted) return;
    try {
      const frame: unknown = JSON.parse(String(event.data));
      if (!frame || typeof frame !== 'object') throw new Error('Invalid status frame');
      const value = frame as Partial<EquipmentStatusSnapshot>;
      // Structural validation only; ordering (sequence/epoch/timestamp) belongs to
      // the shared per-scope gate so the stream is not marked stale by a late frame.
      if (!isInScope(value, scope) || typeof value.generatedAt !== 'string' || !Number.isFinite(Date.parse(value.generatedAt)) ||
        !Array.isArray(value.tools) || value.tools.length === 0 || !value.tools.every(tool => tool &&
          ['running', 'idle', 'down', 'maint'].includes(tool.state))) throw new Error('Invalid status scope or payload');
      onSnapshot(value as EquipmentStatusSnapshot);
      lastValidFrame = Date.now();
    } catch { onStale(); }
  };
  signal.addEventListener('abort', () => {
    clearInterval(timer); source.onmessage = null; source.onerror = null; source.close();
  }, { once: true });
}

/**
 * The ordered acceptance gate of one FAB scope (framework-free on purpose so the
 * REST queryFn and the SSE listener can share the exact same rules).
 *
 * Rules:
 * - In-scope, full, well-typed snapshots only.
 * - `sequence`/timestamp high-water per accepted scope (legacy behaviour is
 *   preserved exactly when no epoch is present).
 * - `epoch` orders server generations: a higher epoch resets the high-water and
 *   is accepted; a lower epoch is a delayed frame from an old generation and is
 *   rejected without being reported as invalid.
 */
export interface EquipmentStatusGate {
  /** Validate + order one candidate frame; returns the accepted snapshot or undefined. */
  readonly accept: (value: unknown) => EquipmentStatusSnapshot | undefined;
}

export function createEquipmentStatusGate(
  scope: EquipmentStatusScope,
  expectedToolCount: number,
  onInvalid?: () => void,
): EquipmentStatusGate {
  let lastGeneratedAt = Number.NEGATIVE_INFINITY;
  let lastSequence = -1;
  let lastEpoch: number | undefined;
  return {
    accept(value: unknown): EquipmentStatusSnapshot | undefined {
      if (!isValidSnapshot(value, scope, expectedToolCount)) {
        onInvalid?.();
        return undefined;
      }
      const snapshot = value;
      const timestamp = Date.parse(snapshot.generatedAt);
      const hasSequence = snapshot.sequence !== undefined;
      const hasEpoch = snapshot.epoch !== undefined;
      if (hasEpoch) {
        // Explicit generation ordering never falls back to display time. The
        // first epoch also replaces all legacy high-water marks.
        if (!hasSequence) { onInvalid?.(); return undefined; }
        const epoch = snapshot.epoch as number;
        const sequence = snapshot.sequence as number;
        if (lastEpoch !== undefined && (epoch < lastEpoch || (epoch === lastEpoch && sequence <= lastSequence))) return undefined;
        lastEpoch = epoch;
        lastSequence = sequence;
        lastGeneratedAt = timestamp;
        return snapshot;
      }
      // A legacy/late response must not downgrade a feed that has established
      // an explicit server generation.
      if (lastEpoch !== undefined) return undefined;
      if (hasSequence) {
        const sequence = snapshot.sequence as number;
        if (sequence < lastSequence) {
          // Legacy-only server-restart heuristic (no explicit epoch observed).
          if (timestamp <= lastGeneratedAt) return undefined;
        } else if (sequence === lastSequence) {
          return undefined;
        }
      } else if (timestamp < lastGeneratedAt) {
        return undefined;
      }
      if (hasSequence) lastSequence = snapshot.sequence as number;
      lastGeneratedAt = timestamp;
      return snapshot;
    },
  };
}

/**
 * Accept only a valid, in-scope snapshot that does not predate the most recently
 * applied REST or SSE frame. Kept for callers that want a boolean consumer; the
 * shared REST/SSE cache boundary lives in equipment-status-bridge.
 */
export function createOrderedEquipmentStatusConsumer(
  scope: EquipmentStatusScope,
  expectedToolCount: number,
  onSnapshot: (snapshot: EquipmentStatusSnapshot) => void,
  onInvalid?: () => void,
): (value: unknown) => boolean {
  const gate = createEquipmentStatusGate(scope, expectedToolCount, onInvalid);
  return (value: unknown): boolean => {
    const accepted = gate.accept(value);
    if (!accepted) return false;
    onSnapshot(accepted);
    return true;
  };
}
