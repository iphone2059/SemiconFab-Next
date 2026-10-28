import {
  addToScene, createGpuPicker, createLineSystem, disposePicker, getMeshGeometry, pickAsync, removeFromScene,
  type EngineContext, type GpuPicker, type Mesh, type PickOptions, type SceneContext, type SceneNode,
} from '@babylonjs/lite';
import { FAB_LAYOUT, FAB_TOOL_STATES, type FabToolState } from '../../domain/fab/fab-layout';
import type { HoveredTool, PickedTool } from '../../application/ports/scene';
import type { EquipmentTool, LiteEquipment } from './geometry/tool-families';

type Triple = [number, number, number];
export type SelectionPoint = readonly [number, number, number];

/** One resolved tool pick in legacy terms: layout index and CSS canvas-local pointer position. */
export interface SelectionPickResult { readonly toolIndex: number; readonly x: number; readonly y: number }
/** Injectable pick seam; production uses the native Lite GPU picker, unit tests can control resolution. */
export interface SelectionPickSeam { pick(x: number, y: number): Promise<SelectionPickResult | null> }
export interface LiteSelectionCallbacks {
  onPick(tool: PickedTool | null): void;
  onHover(hover: HoveredTool | null): void;
  /** Legacy double-click focus: the world applies the camera pose for a direct canvas gesture. */
  onSelectFocus?(index: number): void;
}
/** Minimal shape of a native pick result the identity resolver consumes. */
export interface SelectionPickCandidate {
  readonly hit: boolean;
  readonly pickedMesh: unknown;
  readonly thinInstanceIndex: number;
}
export interface SelectionPickResolver {
  /** Native picker mesh filter: only the equipment batches a tool can resolve from. */
  filter(mesh: Mesh): boolean;
  resolve(candidate: SelectionPickCandidate): number | null;
}
export interface LiteSelectionOptions {
  readonly equipment: LiteEquipment;
  /** Current business state, read at emission time; defaults to the frozen layout states. */
  readonly getToolState?: (index: number) => FabToolState;
  /** Test seam. When omitted, the native createGpuPicker/pickAsync path is used. */
  readonly pick?: SelectionPickSeam;
  /** Hover raycast interval in milliseconds; legacy default 50. */
  readonly hoverPickMs?: number;
  /** Clock seam for the hover throttle; defaults to performance.now. */
  readonly now?: () => number;
}
/** Legacy focus transition data: target + orbit radius/beta, with the current camera alpha preserved. */
export interface SelectionFocusPose { readonly position: SelectionPoint; readonly target: SelectionPoint }
export interface LiteSelection {
  /**
   * Undefined by design: the selection box is authored directly in native render space from the
   * post-frame world matrices, so the world must NOT reparent it through the RH-to-LH frame node.
   */
  readonly root: SceneNode | undefined;
  /** Native GPU picker state; undefined when a test seam supplies picks. Recreated on recovery. */
  readonly picker: GpuPicker | undefined;
  readonly selectedIndex: number | null;
  /** Wire the legacy canvas pointer gestures. Returns the listener teardown. */
  bind(canvas: HTMLCanvasElement, callbacks: LiteSelectionCallbacks): () => void;
  /** Apply the legacy selection visual, emit onPick, and optionally return the focus camera pose. */
  selectTool(index: number, focus?: boolean): SelectionFocusPose | undefined;
  /** Hide the visual; emits onPick(null) only when something was selected (legacy sentinel). */
  clear(): void;
  /** Basement/dual modes disable picking in the frozen backend (findToolAt early-out). */
  setPickingEnabled(enabled: boolean): void;
  readonly pickingEnabled: boolean;
  /** Read-only acceptance counters for the native GPU pick path. */
  readonly stats: { readonly requests: number; readonly hits: number; readonly fails: number;
    readonly lastHit: boolean | null; readonly lastThinInstance: number | null; readonly lastError: string | null };
  /** Recompute the visual against moved equipment (legacy refreshSelection after explode). */
  refresh(): void;
  dispose(): void;
}

// Frozen selection wireframe: babylon-webgpu.ts CreateBox + StandardMaterial.wireframe,
// emissiveColor = new Color3(0.05, 0.64, 0.44), diffuse/specular black, unlit wireframe.
const SELECTION_COLOR = { r: .05, g: .64, b: .44, a: 1 } as const;
const SELECTION_NAME = 'tool-selection';
const SELECTION_MARGIN = .2;
// r128 WireframeGeometry box edges: the twelve cube edges plus each face diagonal.
const UNIT_BOX_CORNERS: readonly (readonly [number, number, number])[] = [
  [-.5, -.5, -.5], [.5, -.5, -.5], [.5, .5, -.5], [-.5, .5, -.5],
  [-.5, -.5, .5], [.5, -.5, .5], [.5, .5, .5], [-.5, .5, .5],
];
const UNIT_BOX_EDGES: readonly (readonly [number, number])[] = [
  [0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4],
  [0, 4], [1, 5], [2, 6], [3, 7],
  [1, 3], [4, 6], [0, 7], [2, 5], [0, 5], [2, 7],
];
// Legacy focus: beta = PI / 3.6, radius = 58, 520 ms ease, alpha unchanged.
const FOCUS_BETA = Math.PI / 3.6;
const FOCUS_RADIUS = 58;
const CLICK_DRAG_TOLERANCE = 6;

const transformPoint = (matrix: ArrayLike<number>, x: number, y: number, z: number): Triple => [
  matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
  matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
  matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
];
/** Column-major 4x4 multiply (a x b), matching the Lite world/instance math. */
const multiplyMat4 = (a: ArrayLike<number>, b: ArrayLike<number>): Float64Array => {
  const out = new Float64Array(16);
  for (let column = 0; column < 4; column++) for (let row = 0; row < 4; row++) {
    out[column * 4 + row] = a[row] * b[column * 4] + a[4 + row] * b[column * 4 + 1]
      + a[8 + row] * b[column * 4 + 2] + a[12 + row] * b[column * 4 + 3];
  }
  return out;
};
/** Object-local AABB of a mesh; Lite geometry factories publish it and legacy bounds use it too. */
function localBounds(mesh: Mesh): { min: Triple; max: Triple } | null {
  if (mesh.boundMin && mesh.boundMax) return { min: [...mesh.boundMin], max: [...mesh.boundMax] };
  const geometry = getMeshGeometry(mesh);
  if (!geometry || geometry.positions.length === 0) return null;
  const min: Triple = [Infinity, Infinity, Infinity], max: Triple = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < geometry.positions.length; index += 3) {
    for (let axis = 0; axis < 3; axis++) {
      const value = geometry.positions[index + axis];
      min[axis] = Math.min(min[axis], value); max[axis] = Math.max(max[axis], value);
    }
  }
  return { min, max };
}
/**
 * World-space hierarchy AABB of one equipment tool. This is the frozen
 * `getHierarchyBoundingVectors(true)` equivalent: every authored part (body, pole,
 * status beacon, wire) is composed through its thin-instance matrix and mesh world matrix.
 */
function toolWorldBounds(equipment: LiteEquipment, tool: EquipmentTool): { min: Triple; max: Triple } | null {
  const min: Triple = [Infinity, Infinity, Infinity], max: Triple = [-Infinity, -Infinity, -Infinity];
  let found = false;
  for (const part of tool.parts) {
    const batch = equipment.batches[part.batchIndex];
    if (!batch) continue;
    const mesh = batch.mesh;
    const local = localBounds(mesh);
    if (!local) continue;
    const instances = mesh.thinInstances;
    if (instances && (part.instanceIndex < 0 || part.instanceIndex >= instances.count)) continue;
    const matrix = instances
      ? multiplyMat4(mesh.worldMatrix, instances.matrices.subarray(part.instanceIndex * 16, part.instanceIndex * 16 + 16))
      : mesh.worldMatrix;
    for (const corner of UNIT_BOX_CORNERS) {
      const localX = corner[0] < 0 ? local.min[0] : local.max[0];
      const localY = corner[1] < 0 ? local.min[1] : local.max[1];
      const localZ = corner[2] < 0 ? local.min[2] : local.max[2];
      const point = transformPoint(matrix, localX, localY, localZ);
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis], point[axis]); max[axis] = Math.max(max[axis], point[axis]);
      }
      found = true;
    }
  }
  return found ? { min, max } : null;
}
/** Native-candidate filter and thin-instance identity resolution shared with unit tests. */
export function createSelectionPickResolver(equipment: LiteEquipment): SelectionPickResolver {
  const pickable = new Set<Mesh>();
  for (const tool of equipment.tools) for (const part of tool.parts) {
    // Whole wires carry no pickable volume: legacy created them with isPickable = false.
    if (part.role === 'wire') continue;
    const batch = equipment.batches[part.batchIndex];
    if (batch) pickable.add(batch.mesh);
  }
  return {
    filter: mesh => pickable.has(mesh),
    resolve(candidate) {
      if (!candidate.hit) return null;
      const mesh = candidate.pickedMesh as Mesh | null | undefined;
      if (!mesh || !pickable.has(mesh)) return null;
      const tool = equipment.resolve(mesh, candidate.thinInstanceIndex);
      return tool ? tool.layoutIndex : null;
    },
  };
}
function focusPose(scene: SceneContext, toolIndex: number): SelectionFocusPose | undefined {
  const camera = scene.camera;
  const alpha = camera && 'alpha' in camera ? (camera as { alpha: number }).alpha : undefined;
  if (typeof alpha !== 'number' || !Number.isFinite(alpha)) return undefined;
  const layout = FAB_LAYOUT[toolIndex];
  const target: SelectionPoint = [layout.x, Math.min(1.5, layout.height / 2), layout.z];
  // Native Lite camera is LH; the pose returned here is the frozen Next RH domain pose.
  const position: SelectionPoint = [
    target[0] + Math.cos(alpha) * Math.sin(FOCUS_BETA) * FOCUS_RADIUS,
    target[1] + Math.cos(FOCUS_BETA) * FOCUS_RADIUS,
    target[2] - Math.sin(alpha) * Math.sin(FOCUS_BETA) * FOCUS_RADIUS,
  ];
  return { position, target };
}

interface BindingState {
  readonly canvas: HTMLCanvasElement;
  readonly callbacks: LiteSelectionCallbacks;
  readonly listeners: [string, EventListener][];
}

/** Native picking, hover/click state and the legacy selection wireframe box. */
export function createLiteSelection(scene: SceneContext, engine: EngineContext, options: LiteSelectionOptions): LiteSelection {
  const resolver = createSelectionPickResolver(options.equipment);
  const hoverPickMs = options.hoverPickMs ?? 50;
  const clock = options.now ?? (() => performance.now());
  let picker: GpuPicker | undefined;
  let disposed = false;
  let pickingEnabled = true;
  let selected: number | null = null;
  let activeBinding: BindingState | undefined;
  let lastHoverIndex: number | null = null;
  let lastHoverPickAt = Number.NEGATIVE_INFINITY;
  let hoverRequestId = 0, hoverEpoch = 0;
  let clickRequestId = 0, clickEpoch = 0;
  let pointerDown: { x: number; y: number } | null = null;
  // Hover backpressure (A07): at most one hover pick is in flight; pointer moves while it is
  // pending keep only the latest position, which is picked when the in-flight request settles.
  // Clicks share the same picker and always supersede pending hover work.
  let hoverPending: { x: number; y: number } | null = null;
  let hoverInFlight = false;

  // Legacy babylon-webgpu.ts selection mesh: unit box scaled to the hierarchy bounds + 0.2.
  const visual = createLineSystem(engine, {
    name: SELECTION_NAME,
    color: SELECTION_COLOR,
    // The frozen material is opaque (alpha 1, no alpha blending); line systems default to blended.
    useVertexAlpha: false,
    lines: UNIT_BOX_EDGES.map(([from, to]) => [
      { x: UNIT_BOX_CORNERS[from][0], y: UNIT_BOX_CORNERS[from][1], z: UNIT_BOX_CORNERS[from][2] },
      { x: UNIT_BOX_CORNERS[to][0], y: UNIT_BOX_CORNERS[to][1], z: UNIT_BOX_CORNERS[to][2] },
    ]),
  });
  visual.pickable = false;
  visual.visible = false;
  addToScene(scene, visual);

  function stateOf(index: number): FabToolState {
    return options.getToolState?.(index) ?? FAB_TOOL_STATES[index] ?? 'idle';
  }
  function pickedTool(index: number): PickedTool {
    const tool = FAB_LAYOUT[index];
    return {
      index, x: tool.x, z: tool.z, width: tool.width, depth: tool.depth, height: tool.height,
      category: tool.category, vendor: tool.vendor, model: tool.model, state: stateOf(index),
    };
  }
  function showVisual(index: number): void {
    const tool = options.equipment.tools[index];
    const bounds = tool ? toolWorldBounds(options.equipment, tool) : null;
    if (!bounds) { visual.visible = false; return; }
    visual.position.set(
      (bounds.min[0] + bounds.max[0]) / 2, (bounds.min[1] + bounds.max[1]) / 2, (bounds.min[2] + bounds.max[2]) / 2,
    );
    visual.scaling.set(
      bounds.max[0] - bounds.min[0] + SELECTION_MARGIN,
      bounds.max[1] - bounds.min[1] + SELECTION_MARGIN,
      bounds.max[2] - bounds.min[2] + SELECTION_MARGIN,
    );
    visual.visible = true;
  }
  function hideVisual(): void { visual.visible = false; }

  // Production pick seam. pickAsync already queues concurrent calls on the same picker, so
  // overlapping hover/click picks never race the shared 1x1 readback buffers.
  const pickStats = { requests: 0, hits: 0, fails: 0, lastHit: null as boolean | null,
    lastThinInstance: null as number | null, lastError: null as string | null };
  if (!options.pick) picker = createGpuPicker(scene);
  const nativeSeam: SelectionPickSeam = {
    async pick(x, y) {
      const active = picker;
      if (!active || disposed) return null;
      pickStats.requests += 1;
      const pickOptions: PickOptions = { filter: resolver.filter };
      const info = await pickAsync(active, x, y, pickOptions);
      pickStats.lastHit = info.hit;
      pickStats.lastThinInstance = info.thinInstanceIndex;
      const toolIndex = resolver.resolve({ hit: info.hit, pickedMesh: info.pickedMesh, thinInstanceIndex: info.thinInstanceIndex });
      if (toolIndex !== null) pickStats.hits += 1;
      return toolIndex === null ? null : { toolIndex, x, y };
    },
  };
  const seam = options.pick ?? nativeSeam;
  // A rejected pick (device loss/dispose mid-flight) is not a miss: keep the current state.
  const PICK_FAILED = Symbol('selection-pick-failed');
  const pickSafely = async (x: number, y: number): Promise<SelectionPickResult | null | typeof PICK_FAILED> => {
    try { return await seam.pick(x, y); } catch (error) {
      pickStats.fails += 1; pickStats.lastError = error instanceof Error ? error.message : String(error);
      return PICK_FAILED;
    }
  };
  const validIndex = (index: number | null | undefined): index is number =>
    typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < FAB_LAYOUT.length;

  function emitPick(tool: PickedTool | null): void { activeBinding?.callbacks.onPick(tool); }
  function emitHover(hover: HoveredTool | null): void { activeBinding?.callbacks.onHover(hover); }
  function pointerAt(canvas: HTMLCanvasElement, clientX: number, clientY: number): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }
  function applyHoverResult(binding: BindingState, hit: SelectionPickResult | null): void {
    binding.canvas.style.cursor = hit ? 'pointer' : '';
    const nextIndex = hit && validIndex(hit.toolIndex) ? hit.toolIndex : null;
    if (nextIndex === lastHoverIndex) return;
    lastHoverIndex = nextIndex;
    if (nextIndex === null || !hit) { emitHover(null); return; }
    emitHover({ tool: pickedTool(nextIndex), x: hit.x, y: hit.y });
  }
  /** Invalidate pending/in-flight hover work (pointer leave, drag, click, recovery, dispose). */
  function cancelHoverRequest(): void {
    hoverPending = null;
    hoverEpoch += 1;
    hoverRequestId += 1;
  }
  function queueHover(x: number, y: number): void {
    if (disposed) return;
    // One latest pending position only; a burst of pointer moves never queues more than this.
    hoverPending = { x, y };
    hoverRequestId += 1;
    void pumpHover();
  }
  async function pumpHover(): Promise<void> {
    if (hoverInFlight) return;
    hoverInFlight = true;
    try {
      while (hoverPending) {
        const binding = activeBinding;
        if (disposed || !binding || !pickingEnabled) { hoverPending = null; return; }
        const point = hoverPending;
        hoverPending = null;
        const requestId = hoverRequestId, epoch = hoverEpoch;
        const hit = await pickSafely(point.x, point.y);
        if (disposed || activeBinding !== binding || !pickingEnabled
          || requestId !== hoverRequestId || epoch !== hoverEpoch) return;
        if (hit === PICK_FAILED) return;
        // A position that arrived while this pick was in flight supersedes its result.
        if (hoverPending) continue;
        applyHoverResult(binding, hit);
      }
    } finally {
      hoverInFlight = false;
      // Process the latest position that superseded a just-discarded result (or arrived while
      // the owning binding was being replaced) exactly once.
      if (hoverPending && !disposed && activeBinding && pickingEnabled) void pumpHover();
    }
  }
  async function applyClick(binding: BindingState, x: number, y: number, focus: boolean): Promise<void> {
    // Clicks have explicit priority over hover: drop the pending position and any in-flight
    // hover result so it can never overwrite the click's selection afterwards.
    cancelHoverRequest();
    const requestId = ++clickRequestId, epoch = clickEpoch;
    const hit = await pickSafely(x, y);
    if (disposed || activeBinding !== binding || requestId !== clickRequestId || epoch !== clickEpoch) return;
    if (hit === PICK_FAILED) return;
    const index = hit && pickingEnabled && validIndex(hit.toolIndex) ? hit.toolIndex : null;
    if (index === null) { selection.clear(); return; }
    selection.selectTool(index, focus);
    if (focus) binding.callbacks.onSelectFocus?.(index);
  }
  const selection: LiteSelection = {
    // The wireframe is already expressed in native render space; frame composition must skip it.
    get root() { return undefined; },
    get picker() { return picker; },
    get selectedIndex() { return selected; },
    get stats() { return { ...pickStats }; },
    get pickingEnabled() { return pickingEnabled; },
    bind(canvas, callbacks) {
      if (disposed) return () => {};
      const listeners: [string, EventListener][] = [];
      const binding: BindingState = { canvas, callbacks, listeners };
      const add = (type: string, listener: EventListener) => {
        canvas.addEventListener(type, listener);
        listeners.push([type, listener]);
      };
      const onPointerDown = (event: PointerEvent) => {
        if (activeBinding !== binding) return;
        pointerDown = { x: event.clientX, y: event.clientY };
      };
      const onPointerUp = (event: PointerEvent) => {
        if (activeBinding !== binding || disposed || !pointerDown) return;
        const start = pointerDown; pointerDown = null;
        if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > CLICK_DRAG_TOLERANCE) return;
        // Legacy findToolAt early-outs in basement mode, so the click resolves as a miss.
        if (!pickingEnabled) { selection.clear(); return; }
        const point = pointerAt(canvas, event.clientX, event.clientY);
        void applyClick(binding, point.x, point.y, false);
      };
      const onPointerMove = (event: PointerEvent) => {
        if (activeBinding !== binding || disposed) return;
        if (event.buttons !== 0) {
          // A drag cancels any older hover resolution so the tooltip cannot reappear mid-gesture.
          cancelHoverRequest();
          canvas.style.cursor = '';
          return;
        }
        if (!pickingEnabled) {
          cancelHoverRequest();
          canvas.style.cursor = '';
          if (lastHoverIndex !== null) { lastHoverIndex = null; emitHover(null); }
          return;
        }
        const current = clock();
        // Legacy hoverPickMs gate: 50 ms is visually indistinguishable from per-pixel picking.
        if (current - lastHoverPickAt < hoverPickMs) return;
        lastHoverPickAt = current;
        const point = pointerAt(canvas, event.clientX, event.clientY);
        queueHover(point.x, point.y);
      };
      const onPointerLeave = () => {
        if (activeBinding !== binding || disposed) return;
        cancelHoverRequest();
        lastHoverIndex = null;
        emitHover(null);
      };
      const onDoubleClick = (event: MouseEvent) => {
        if (activeBinding !== binding || disposed || !pickingEnabled) return;
        const point = pointerAt(canvas, event.clientX, event.clientY);
        void applyClick(binding, point.x, point.y, true);
      };
      add('pointerdown', onPointerDown as EventListener);
      add('pointerup', onPointerUp as EventListener);
      add('pointermove', onPointerMove as EventListener);
      add('pointerleave', onPointerLeave as EventListener);
      add('dblclick', onDoubleClick as EventListener);
      // A new binding starts from a clean hover state; stale positions belong to the old canvas.
      cancelHoverRequest();
      lastHoverIndex = null;
      activeBinding = binding;
      return () => {
        for (const [type, listener] of listeners) canvas.removeEventListener(type, listener);
        listeners.length = 0;
        if (activeBinding === binding) { activeBinding = undefined; cancelHoverRequest(); }
      };
    },
    selectTool(index, focus = false) {
      if (disposed) return undefined;
      if (!Number.isInteger(index) || !FAB_LAYOUT[index]) return undefined;
      // A newer selection invalidates every older in-flight pick.
      clickEpoch++;
      selected = index;
      showVisual(index);
      emitPick(pickedTool(index));
      return focus ? focusPose(scene, index) : undefined;
    },
    clear() {
      if (disposed) return;
      clickEpoch++;
      hideVisual();
      if (selected !== null) { selected = null; emitPick(null); }
    },
    setPickingEnabled(enabled) {
      if (disposed || pickingEnabled === enabled) return;
      pickingEnabled = enabled;
      cancelHoverRequest();
      clickEpoch++;
      if (!enabled && lastHoverIndex !== null) { lastHoverIndex = null; emitHover(null); }
    },
    refresh() {
      if (disposed || selected === null) return;
      showVisual(selected);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      selected = null; lastHoverIndex = null;
      clickEpoch++;
      cancelHoverRequest();
      const binding = activeBinding;
      if (binding) {
        for (const [type, listener] of binding.listeners) binding.canvas.removeEventListener(type, listener);
        binding.listeners.length = 0;
        activeBinding = undefined;
      }
      removeFromScene(scene, visual);
      if (picker) disposePicker(picker);
      picker = undefined;
    },
  };
  return selection;
}
