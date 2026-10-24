export type EquipmentStateCode = 'running' | 'idle' | 'down' | 'maint';

export interface EquipmentStatusItem {
  readonly state: string;
}

export interface EquipmentStatusSnapshot {
  readonly siteId: string;
  readonly generatedAt: string;
  readonly tools: EquipmentStatusItem[];
}

/** Keep the last good snapshot visible, but never label a disconnected/stalled stream LIVE. */
export function watchEquipmentStatus(
  source: EventSource,
  siteId: string,
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
      if (value.siteId !== siteId || typeof value.generatedAt !== 'string' || !Number.isFinite(Date.parse(value.generatedAt)) ||
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
 * Accept only a valid, in-scope snapshot that does not predate the most recently
 * applied REST or SSE frame. This is intentionally shared by both transports.
 * A server-issued monotonically increasing revision should eventually replace
 * the timestamp high-water mark when the API exposes one.
 */
export function createOrderedEquipmentStatusConsumer(
  siteId: string,
  expectedToolCount: number,
  onSnapshot: (snapshot: EquipmentStatusSnapshot) => void,
  onInvalid?: () => void,
): (value: unknown) => boolean {
  let lastGeneratedAt = Number.NEGATIVE_INFINITY;
  return (value: unknown): boolean => {
    if (typeof value !== 'object' || value === null) {
      onInvalid?.();
      return false;
    }
    const snapshot = value as Partial<EquipmentStatusSnapshot>;
    const timestamp = typeof snapshot.generatedAt === 'string'
      ? Date.parse(snapshot.generatedAt)
      : Number.NaN;
    if (snapshot.siteId !== siteId || !Number.isFinite(timestamp) ||
        !Array.isArray(snapshot.tools) || snapshot.tools.length !== expectedToolCount ||
        !snapshot.tools.every(tool =>
          tool !== null && typeof tool === 'object' &&
          (tool.state === 'running' || tool.state === 'idle' ||
           tool.state === 'down' || tool.state === 'maint'))) {
      onInvalid?.();
      return false;
    }
    if (timestamp < lastGeneratedAt) return false;
    lastGeneratedAt = timestamp;
    onSnapshot(snapshot as EquipmentStatusSnapshot);
    return true;
  };
}
