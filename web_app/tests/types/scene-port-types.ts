/**
 * Compile-time negative contract tests for the application ScenePort (R-04).
 *
 * Vitest never executes this file (it is not a *.test.* module); `tsc --noEmit` proves the
 * browser-facing scene contract cannot regress into optional product capabilities again. If a
 * required command becomes optional, the production implementation check, the per-capability
 * `@ts-expect-error` fixtures or the derived no-optional guard below stop compiling.
 *
 * The previous rendering/fab-scene.ts module is gone on purpose: the port lives in
 * application/ports/scene.ts and there is no forwarding compatibility layer.
 */
import type {
  SceneCallbacks, SceneCommands, SceneLifecycleEvent, SceneMountOptions, SceneMountOutcome, ScenePort,
} from '../../src/application/ports/scene';
import { createLiteBackend } from '../../src/rendering/lite-backend';

// Positive control: the production Lite backend is a complete ScenePort implementation
// (checked by the compiler, not by a runtime list only).
const productionPort: ScenePort = createLiteBackend();

const commands: SceneCommands = {
  setView() {},
  setCameraPose() {},
  getCameraPose() { return null; },
  zoom() {},
  resize() {},
  clearSelection() {},
  selectTool() {},
  setLayer() {},
  setToolState() {},
  setTour() {},
  setExplodeFactor() {},
  setBasement() {},
  setDual() {},
  setCutPlane() {},
  setXRayFilter() {},
  setWaferPoint() {},
  setWaferTrail() {},
  focusPatrol() {},
  setLanguage() {},
};

const callbacks: SceneCallbacks = {
  onLifecycle() {},
  onToolPick() {},
  onToolHover() {},
  onAmhsStats() {},
  getToolStates: () => [],
};

const options: SceneMountOptions = {
  viewerId: 'epoch-1',
  canvas: document.createElement('canvas'),
  fabs: [],
  signal: new AbortController().signal,
  callbacks,
};

// Positive controls: the intended typed mount options and command surface keep compiling.
productionPort.setView('iso');
productionPort.setCameraPose([0, 1, 0], [0, 0, 0], 0);
productionPort.setCutPlane(true, 'Y', 0, false);
productionPort.setXRayFilter(null);
productionPort.setWaferTrail([[0, 0, 0]]);
const mountOutcome: Promise<SceneMountOutcome> = productionPort.mount(options);
void mountOutcome;
const describeLifecycle = (event: SceneLifecycleEvent): string =>
  event.type === 'recovering' ? event.cause : event.message;
void describeLifecycle;

// Positive control: a port without the optional acceptance group is still a valid ScenePort.
const completePort: ScenePort = { ...commands, mount: async () => ({ status: 'ready' }), dispose() {} };

// @ts-expect-error the old long positional mount(canvas, fabs, signal, onStatus, ...) signature is gone
void productionPort.mount(document.createElement('canvas'), [], new AbortController().signal, () => {});

// @ts-expect-error mount options require the stable viewer identity
void productionPort.mount({ canvas: options.canvas, fabs: [], signal: options.signal, callbacks });
// @ts-expect-error cancellation is a required AbortSignal on the mount contract
void productionPort.mount({ ...options, signal: undefined });
// @ts-expect-error callbacks are one required readonly collection, not optional hooks
void productionPort.mount({ ...options, callbacks: undefined });
// @ts-expect-error every callback in the collection is required (no silent optional success)
void productionPort.mount({ ...options, callbacks: { ...callbacks, onToolPick: undefined } });
// @ts-expect-error the frame loop tool-state source is a required scene capability
void productionPort.mount({ ...options, callbacks: { ...callbacks, getToolStates: undefined } });

// Negative: a backend exposing only mount/dispose must not satisfy ScenePort.
// @ts-expect-error every product capability is required
const mountOnly: ScenePort = { mount: async () => ({ status: 'ready' }), dispose() {} };
void mountOnly;

// Negative: each previously optional product capability is mandatory now. The
// browser-facing product really calls every one of these through FabViewportHandle.
// @ts-expect-error setView is a required capability, not setView?
const missingSetView: ScenePort = { ...completePort, setView: undefined };
void missingSetView;
// @ts-expect-error setCameraPose is a required capability
const missingSetCameraPose: ScenePort = { ...completePort, setCameraPose: undefined };
void missingSetCameraPose;
// @ts-expect-error getCameraPose is a required capability
const missingGetCameraPose: ScenePort = { ...completePort, getCameraPose: undefined };
void missingGetCameraPose;
// @ts-expect-error zoom is a required capability
const missingZoom: ScenePort = { ...completePort, zoom: undefined };
void missingZoom;
// @ts-expect-error resize is a required capability, not resize?
const missingResize: ScenePort = { ...completePort, resize: undefined };
void missingResize;
// @ts-expect-error clearSelection is a required capability
const missingClearSelection: ScenePort = { ...completePort, clearSelection: undefined };
void missingClearSelection;
// @ts-expect-error selectTool is a required capability, not selectTool?
const missingSelectTool: ScenePort = { ...completePort, selectTool: undefined };
void missingSelectTool;
// @ts-expect-error setLayer is a required capability
const missingSetLayer: ScenePort = { ...completePort, setLayer: undefined };
void missingSetLayer;
// @ts-expect-error setToolState is a required capability
const missingSetToolState: ScenePort = { ...completePort, setToolState: undefined };
void missingSetToolState;
// @ts-expect-error setTour is a required capability
const missingSetTour: ScenePort = { ...completePort, setTour: undefined };
void missingSetTour;
// @ts-expect-error setExplodeFactor is a required capability
const missingSetExplodeFactor: ScenePort = { ...completePort, setExplodeFactor: undefined };
void missingSetExplodeFactor;
// @ts-expect-error setBasement is a required capability
const missingSetBasement: ScenePort = { ...completePort, setBasement: undefined };
void missingSetBasement;
// @ts-expect-error setDual is a required capability
const missingSetDual: ScenePort = { ...completePort, setDual: undefined };
void missingSetDual;
// @ts-expect-error setCutPlane is a required capability
const missingSetCutPlane: ScenePort = { ...completePort, setCutPlane: undefined };
void missingSetCutPlane;
// @ts-expect-error setXRayFilter is a required capability, not setXRayFilter?
const missingSetXRayFilter: ScenePort = { ...completePort, setXRayFilter: undefined };
void missingSetXRayFilter;
// @ts-expect-error setWaferPoint is a required capability
const missingSetWaferPoint: ScenePort = { ...completePort, setWaferPoint: undefined };
void missingSetWaferPoint;
// @ts-expect-error setWaferTrail is a required capability
const missingSetWaferTrail: ScenePort = { ...completePort, setWaferTrail: undefined };
void missingSetWaferTrail;
// @ts-expect-error focusPatrol is a required capability
const missingFocusPatrol: ScenePort = { ...completePort, focusPatrol: undefined };
void missingFocusPatrol;
// @ts-expect-error setLanguage is a required capability
const missingSetLanguage: ScenePort = { ...completePort, setLanguage: undefined };
void missingSetLanguage;

// Generic guard: no SceneCommands member may be optional (a regression makes this key set
// non-empty so 'setView' becomes assignable and the unused @ts-expect-error fails the build).
type OptionalCommandKeys = {
  [K in keyof SceneCommands]-?: undefined extends SceneCommands[K] ? K : never;
}[keyof SceneCommands];
// @ts-expect-error every product command must be required
const optionalCommand: OptionalCommandKeys = 'setView';
void optionalCommand;

// Negative: the acceptance capability group is genuinely optional and must be narrowed; the
// product path never calls it without an explicit check.
// @ts-expect-error the optional acceptance capability group may be absent
productionPort.acceptance.forceDeviceLoss();

// Negative: rendering/fab-scene.ts was replaced (no forwarding module, no compatibility path).
// @ts-expect-error the scene contract lives in application/ports/scene.ts only
import { SceneFacade } from '../../src/rendering/fab-scene';
void SceneFacade;
