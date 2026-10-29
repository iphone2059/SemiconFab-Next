import { useEffect } from 'react';
import { DEMO_TICK_MS } from '@/domain/simulation-twin-equipment';
import { twinDemoActions } from '@/twin/twin-demo.atom';
import type { StatusSource } from '@/twin/twin-state';

/**
 * DEMO status source advances its simulated cycle on its own 1600 ms clock while
 * it is the active source and playing. Live/replay modes never tick the demo.
 */
export function useTwinDemoClock(statusSource: StatusSource, demoPlaying: boolean): void {
  useEffect(() => {
    if (statusSource !== 'demo' || !demoPlaying) return;
    const timer = window.setInterval(() => twinDemoActions.tick(), DEMO_TICK_MS);
    return () => window.clearInterval(timer);
  }, [statusSource, demoPlaying]);
}
