import { expect, it } from 'vitest';
import { bindViewerZoom } from '../src/viewer-zoom';

class Surface extends EventTarget {
  matchesCanvas = true;
  closest(selector: string): unknown { return selector === 'canvas' && this.matchesCanvas ? this : null; }
}
function wheel(deltaY: number, deltaMode = 0, ctrlKey = true): Event {
  return Object.assign(new Event('wheel', { bubbles: true, cancelable: true }), { deltaY, deltaMode, ctrlKey });
}

it('routes trackpad pinch and wheel to scene zoom, normalizes units, and detaches cleanly', () => {
  const surface = new Surface();
  const deltas: number[] = [];
  const detach = bindViewerZoom(surface as unknown as HTMLElement, (delta) => deltas.push(delta));
  const pinch = wheel(-40);
  surface.dispatchEvent(pinch);
  surface.dispatchEvent(wheel(2, 1, false));
  surface.dispatchEvent(wheel(1, 2, false));
  expect(deltas).toEqual([-40, 32, 400]);
  expect(pinch.defaultPrevented).toBe(true);
  detach();
  surface.dispatchEvent(wheel(80));
  expect(deltas).toHaveLength(3);
});

it('preserves ordinary panel scrolling and does not zoom an event already consumed by a child viewer', () => {
  const surface = new Surface(); surface.matchesCanvas = false;
  const deltas: number[] = [];
  const detach = bindViewerZoom(surface as unknown as HTMLElement, (delta) => deltas.push(delta));
  const scroll = wheel(50, 0, false);
  surface.dispatchEvent(scroll);
  expect(scroll.defaultPrevented).toBe(false);
  const consumed = wheel(50); consumed.preventDefault();
  surface.dispatchEvent(consumed);
  expect(deltas).toEqual([]);
  surface.dispatchEvent(wheel(-50));
  expect(deltas).toEqual([-50]);
  detach();
});

it('uses incremental native gesture scale in both directions instead of blocking it', () => {
  const surface = new Surface();
  const deltas: number[] = [];
  const detach = bindViewerZoom(surface as unknown as HTMLElement, (delta) => deltas.push(delta));
  surface.dispatchEvent(Object.assign(new Event('gesturestart', { cancelable: true }), { scale: 1 }));
  surface.dispatchEvent(Object.assign(new Event('gesturechange', { cancelable: true }), { scale: 1.2 }));
  surface.dispatchEvent(Object.assign(new Event('gesturechange', { cancelable: true }), { scale: 1 }));
  expect(deltas[0]).toBeLessThan(0);
  expect(deltas[1]).toBeGreaterThan(0);
  expect(deltas[0] + deltas[1]).toBeCloseTo(0);
  detach();
});
