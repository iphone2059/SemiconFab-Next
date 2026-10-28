import { useEffect } from 'react';
import type { TwinView } from '../state/twin-state';

export interface TwinKeyboardParams {
  /** Escape closes overlays/selection and stops the tour through the UI reducer. */
  onEscape(): void;
  setCamera(view: TwinView): void;
}

/**
 * Global Twin keyboard shortcuts: Escape closes transient UI and 1/2 switch the
 * camera presets. Registered once; the handlers read the latest callbacks from
 * their first-render closure exactly like the former inline effect.
 */
export function useTwinKeyboard({ onEscape, setCamera }: TwinKeyboardParams): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.key === 'Escape') {
        onEscape();
        return;
      }
      if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
      if (event.key === '1') setCamera('iso');
      if (event.key === '2') setCamera('top');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
