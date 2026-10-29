import {
  decodeEquipmentStatusFrame,
  type EquipmentStatusScope,
  type EquipmentStatusSnapshot,
} from '@/realtime/equipment-status.protocol';

/**
 * SSE transport of the FAB-scoped equipment status feed.
 *
 * The transport owns only the browser EventSource lifecycle, the stall timer and
 * the stale signalling; it decodes through protocol.ts and leaves ordering to
 * gate.ts. A structurally valid but late frame is therefore delivered to
 * onSnapshot (where the ordered gate rejects it) instead of marking the stream
 * stale.
 */
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
      onSnapshot(decodeEquipmentStatusFrame(String(event.data), scope));
      lastValidFrame = Date.now();
    } catch { onStale(); }
  };
  signal.addEventListener('abort', () => {
    clearInterval(timer); source.onmessage = null; source.onerror = null; source.close();
  }, { once: true });
}
