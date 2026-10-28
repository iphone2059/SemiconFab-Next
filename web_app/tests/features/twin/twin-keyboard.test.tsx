// @vitest-environment jsdom
import { StrictMode, type RefObject } from 'react';
import { cleanup, fireEvent, render, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Modal } from '../../../src/components/modal';
import type { FabToolState } from '../../../src/domain/fab/fab-layout';
import type { SceneLayer } from '../../../src/application/ports/scene';
import { useTwinActions } from '../../../src/features/twin/controllers/use-twin-actions';
import { useTwinKeyboard } from '../../../src/features/twin/controllers/use-twin-keyboard';
import type { FabViewportHandle } from '../../../src/features/twin/fab-viewer';
import type { TwinView } from '../../../src/features/twin/state/twin-state';
import { resetTwinUiStore, useTwinUiStore } from '../../../src/features/twin/state/twinUiStore';
import { installNativeDialogPolyfill } from '../../support/native-dialog';

installNativeDialogPolyfill();

const LAYERS: Record<SceneLayer, boolean> = {
  amhs: true, ceiling: false, roof: false, subfab: false, heatmap: false, airflow: false, xray: false,
};
const TOOL_STATES: readonly FabToolState[] = ['running'];

/** Every FabViewportHandle member is a spy so the keyboard path is observable without a GPU. */
function createSceneHandle(): FabViewportHandle {
  return {
    setView: vi.fn(),
    setCameraPose: vi.fn(),
    getCameraPose: vi.fn(() => null),
    zoom: vi.fn(),
    resize: vi.fn(),
    reload: vi.fn(),
    selectTool: vi.fn(),
    clearSelection: vi.fn(),
    setLayer: vi.fn(),
    setToolState: vi.fn(),
    setTour: vi.fn(),
    setExplodeFactor: vi.fn(),
    setBasement: vi.fn(),
    setDual: vi.fn(),
    setCutPlane: vi.fn(),
    setXRayFilter: vi.fn(),
    setWaferPoint: vi.fn(),
    setWaferTrail: vi.fn(),
    focusPatrol: vi.fn(),
    setLanguage: vi.fn(),
  };
}

function press(key: string, target: Element = document.body, init: KeyboardEventInit = {}): void {
  fireEvent.keyDown(target, { key, code: key, ...init });
}

beforeEach(() => resetTwinUiStore());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetTwinUiStore();
});

interface SurfaceProps {
  onEscape: () => void;
  setCamera: (view: TwinView) => void;
}

function KeyboardSurface({ onEscape, setCamera }: SurfaceProps) {
  useTwinKeyboard({ onEscape, setCamera });
  return (
    <div>
      <input id="text-input" />
      <select id="select-input"><option>one</option></select>
      <textarea id="text-area" />
      <div id="editable" contentEditable suppressContentEditableWarning />
      <div id="plain" />
    </div>
  );
}

it('calls the latest onEscape/setCamera after rerender without re-registering the listener', () => {
  const addKeydown = vi.spyOn(window, 'addEventListener');
  const firstEscape = vi.fn();
  const secondEscape = vi.fn();
  const firstCamera = vi.fn();
  const secondCamera = vi.fn();
  const { rerender } = renderHook(
    (props: SurfaceProps) => useTwinKeyboard(props),
    { initialProps: { onEscape: firstEscape, setCamera: firstCamera } },
  );
  expect(addKeydown.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(1);

  press('Escape');
  expect(firstEscape).toHaveBeenCalledTimes(1);
  expect(secondEscape).not.toHaveBeenCalled();

  rerender({ onEscape: secondEscape, setCamera: secondCamera });
  expect(addKeydown.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(1);

  press('Escape');
  press('1');
  expect(firstEscape).toHaveBeenCalledTimes(1);
  expect(secondEscape).toHaveBeenCalledTimes(1);
  expect(firstCamera).not.toHaveBeenCalled();
  expect(secondCamera).toHaveBeenCalledWith('iso');
});

it('re-centres the active Top preset after a manual camera move (ISO -> Top -> drag -> 2)', () => {
  const handle = createSceneHandle();
  const scene: RefObject<FabViewportHandle | null> = { current: handle };

  function TwinActionsHarness({ ref }: { ref: RefObject<FabViewportHandle | null> }) {
    const view = useTwinUiStore((state) => state.view);
    const actions = useTwinActions({
      scene: ref, mode: 'engineer', view, level: 'L1', exploded: false,
      mesJobs: {}, layerPreferences: LAYERS, toolStates: TOOL_STATES,
      onboardingDontShow: false, startTour: () => {},
    });
    useTwinKeyboard({ onEscape: actions.escape, setCamera: actions.setCamera });
    return null;
  }

  render(<TwinActionsHarness ref={scene} />);
  // ISO is the initial preset, so the baseline semantics of pressing 1 on the
  // already-active preset is an immediate re-centre.
  press('1');
  expect(useTwinUiStore.getState().view).toBe('iso');
  expect(handle.setView).toHaveBeenNthCalledWith(1, 'iso');

  press('2');
  expect(useTwinUiStore.getState().view).toBe('top');
  expect(handle.setView).toHaveBeenCalledTimes(1);

  // The user drags the camera: the store preset stays 'top' but the camera pose
  // is no longer the Top preset. Pressing 2 must re-apply (re-centre) Top via the
  // LATEST setCamera closure, not the one captured when the listener mounted.
  vi.mocked(handle.setView).mockClear();
  press('2');
  expect(handle.setView).toHaveBeenCalledTimes(1);
  expect(handle.setView).toHaveBeenCalledWith('top');
  expect(useTwinUiStore.getState().view).toBe('top');
});

it('ignores camera shortcuts from text-entry and contenteditable targets', () => {
  const onEscape = vi.fn();
  const setCamera = vi.fn();
  const { container } = render(<KeyboardSurface onEscape={onEscape} setCamera={setCamera} />);
  for (const id of ['text-input', 'select-input', 'text-area', 'editable']) {
    const target = container.querySelector('#' + id);
    expect(target, id).not.toBeNull();
    press('1', target as Element);
    press('2', target as Element);
  }
  expect(setCamera).not.toHaveBeenCalled();

  // The same shortcuts keep working outside text entry (focus stays on body).
  press('1');
  expect(setCamera).toHaveBeenCalledWith('iso');
  press('2');
  expect(setCamera).toHaveBeenCalledWith('top');

  // Escape is a global overlay command, not a text-editing shortcut.
  press('Escape', container.querySelector('#text-input') as Element);
  expect(onEscape).toHaveBeenCalledTimes(1);
});

it('ignores keys while an IME composition is active', () => {
  const onEscape = vi.fn();
  const setCamera = vi.fn();
  render(<KeyboardSurface onEscape={onEscape} setCamera={setCamera} />);

  const composing = new KeyboardEvent('keydown', { key: '2', bubbles: true, cancelable: true, isComposing: true });
  document.body.dispatchEvent(composing);
  const composingEscape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, isComposing: true });
  document.body.dispatchEvent(composingEscape);
  const legacy = new KeyboardEvent('keydown', { key: '1', bubbles: true, cancelable: true });
  Object.defineProperty(legacy, 'keyCode', { value: 229 });
  document.body.dispatchEvent(legacy);

  expect(setCamera).not.toHaveBeenCalled();
  expect(onEscape).not.toHaveBeenCalled();

  press('1');
  expect(setCamera).toHaveBeenCalledWith('iso');
});

it('lets the topmost native dialog own Escape and ignores consumed events', () => {
  const onEscape = vi.fn();
  const setCamera = vi.fn();
  render(<KeyboardSurface onEscape={onEscape} setCamera={setCamera} />);

  const dialog = document.createElement('dialog');
  dialog.setAttribute('open', '');
  document.body.appendChild(dialog);
  press('Escape');
  press('2');
  expect(onEscape).not.toHaveBeenCalled();
  expect(setCamera).not.toHaveBeenCalled();
  dialog.remove();

  press('Escape');
  expect(onEscape).toHaveBeenCalledTimes(1);

  // An event another handler already defaultPrevented is consumed.
  const consume = (event: Event) => event.preventDefault();
  document.addEventListener('keydown', consume, { capture: true });
  try {
    press('Escape');
    press('2');
  } finally {
    document.removeEventListener('keydown', consume, { capture: true });
  }
  expect(onEscape).toHaveBeenCalledTimes(1);
  expect(setCamera).not.toHaveBeenCalled();
});

it('defers Escape to an open Modal and keeps camera shortcuts inert while it owns focus', async () => {
  const onEscape = vi.fn();
  const setCamera = vi.fn();
  const onClose = vi.fn();
  render(
    <div>
      <KeyboardSurface onEscape={onEscape} setCamera={setCamera} />
      <Modal className="content" backdropClassName="backdrop" onClose={onClose} label="Twin info">
        <button autoFocus>Dialog action</button>
      </Modal>
    </div>,
  );
  await waitFor(() => expect(document.activeElement?.textContent).toBe('Dialog action'));

  fireEvent.keyDown(document.activeElement as Element, { key: 'Escape', code: 'Escape' });
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onEscape).not.toHaveBeenCalled();

  fireEvent.keyDown(document.activeElement as Element, { key: '2', code: '2' });
  expect(setCamera).not.toHaveBeenCalled();
});

it('registers a single listener under StrictMode and removes it on unmount', () => {
  const onEscape = vi.fn();
  const setCamera = vi.fn();
  const add = vi.spyOn(window, 'addEventListener');
  const remove = vi.spyOn(window, 'removeEventListener');

  // A root-level StrictMode element is required for the dev double-effect
  // contract; renderHook's wrapper indirection does not trigger it.
  const { unmount } = render(
    <StrictMode><KeyboardSurface onEscape={onEscape} setCamera={setCamera} /></StrictMode>,
  );

  const added = add.mock.calls.filter(([type]) => type === 'keydown');
  const removed = remove.mock.calls.filter(([type]) => type === 'keydown');
  expect(added).toHaveLength(2);
  expect(removed).toHaveLength(1);
  expect(added[0][1]).toBe(removed[0][1]);

  press('Escape');
  expect(onEscape).toHaveBeenCalledTimes(1);

  unmount();
  const removedAfterUnmount = remove.mock.calls.filter(([type]) => type === 'keydown');
  expect(removedAfterUnmount).toHaveLength(2);
  press('Escape');
  expect(onEscape).toHaveBeenCalledTimes(1);
});
