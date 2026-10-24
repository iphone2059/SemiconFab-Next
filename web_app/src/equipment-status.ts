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
