import { useEffect, useEffectEvent } from 'react';
import type { TwinView } from '../state/twin-state';

export interface TwinKeyboardParams {
  /** Escape closes overlays/selection and stops the tour through the UI reducer. */
  onEscape(): void;
  setCamera(view: TwinView): void;
}

/** Text-entry surfaces own 1/2; contenteditable covers rich-text editors. */
function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return true;
  return target.isContentEditable
    || target.closest('[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]') !== null;
}

/** A native modal dialog owns the keyboard while it is in the top layer. */
function hasOpenDialog(): boolean {
  return document.querySelector('dialog[open]') !== null;
}

/**
 * Global Twin keyboard shortcuts: Escape closes transient UI and 1/2 switch the
 * camera presets.
 *
 * The window listener is registered exactly once per mount, but every keystroke
 * reads the latest rendered callbacks through useEffectEvent. Capturing them in
 * a first-render closure is incorrect: useTwinActions.setCamera compares the
 * requested preset against the render's current view, so a stale closure stops
 * re-centring a manually moved camera after the preset changed. useEffectEvent
 * (verified available in react 19.3.1) may be invoked from a DOM event dispatch
 * outside rendering; it is the documented primitive for this listener contract.
 */
export function useTwinKeyboard({ onEscape, setCamera }: TwinKeyboardParams): void {
  const onKeyDown = useEffectEvent((event: KeyboardEvent): void => {
    // Another handler already consumed the keystroke (e.g. the focused Modal
    // dialog calls stopPropagation/preventDefault for Escape).
    if (event.defaultPrevented) return;
    // IME composition keystrokes, including the legacy process key 229, belong
    // to the editor. Escape must not close overlays mid-composition either.
    if (event.isComposing || event.keyCode === 229) return;
    // A native modal dialog is the topmost keyboard owner: Escape closes it
    // through the Modal wrapper and background camera shortcuts stay inert.
    if (hasOpenDialog()) return;
    if (event.key === 'Escape') {
      onEscape();
      return;
    }
    if (isTextEntryTarget(event.target)) return;
    if (event.key === '1') setCamera('iso');
    else if (event.key === '2') setCamera('top');
  });

  useEffect(() => {
    const listener = (event: KeyboardEvent): void => onKeyDown(event);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);
}
