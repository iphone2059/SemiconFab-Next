/** One wheel/trackpad/native-gesture owner per scene; touch pinch stays with Babylon. */
export function bindViewerZoom(root: HTMLElement, zoom: (deltaY: number) => void): () => void {
  const onWheel = (event: WheelEvent) => {
    if (event.defaultPrevented || !Number.isFinite(event.deltaY)) return;
    const target = event.target as Element | null;
    if (!event.ctrlKey && !target?.closest?.('canvas')) return;
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
    zoom(event.deltaY * unit);
  };
  let previousScale = 1;
  const start = (event: Event) => {
    event.preventDefault();
    previousScale = 1;
  };
  const change = (event: Event) => {
    if (event.defaultPrevented) return;
    const scale = (event as Event & { scale?: number }).scale;
    if (typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 0) return;
    event.preventDefault();
    zoom(-Math.log(scale / previousScale) / 0.0028);
    previousScale = scale;
  };
  root.addEventListener('wheel', onWheel, { passive: false });
  root.addEventListener('gesturestart', start, { passive: false });
  root.addEventListener('gesturechange', change, { passive: false });
  return () => {
    root.removeEventListener('wheel', onWheel);
    root.removeEventListener('gesturestart', start);
    root.removeEventListener('gesturechange', change);
  };
}
