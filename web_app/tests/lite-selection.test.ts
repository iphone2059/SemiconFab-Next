import { expect, it, vi } from 'vitest';
vi.hoisted(() => Object.assign(globalThis, {
  GPUBufferUsage: { VERTEX: 32, INDEX: 16, COPY_DST: 8, UNIFORM: 64 },
  GPUTextureUsage: { RENDER_ATTACHMENT: 16, TEXTURE_BINDING: 4 },
}));
import {
  addToScene, createArcRotateCamera, createBox, createSceneContext, disposeScene, getMeshGeometry,
  type EngineContext, type LineMaterial, type Mesh,
} from '@babylonjs/lite';
import { FAB_LAYOUT, FAB_TOOL_STATES } from '../src/fab-layout';
import { createLiteEquipment, type LiteEquipment } from '../src/render/lite/geometry/tool-families';
import {
  createLiteSelection, createSelectionPickResolver,
  type LiteSelection, type LiteSelectionCallbacks, type SelectionPickSeam,
} from '../src/render/lite/selection';
import type { HoveredTool, PickedTool } from '../src/fab-scene';

type Triple = [number, number, number];
interface PickCall { x: number; y: number; resolve(value: { toolIndex: number; x: number; y: number } | null): void }
interface FakeCanvas { style: { cursor: string }; rect: { left: number; top: number; width: number; height: number }; listeners: Map<string, Set<(event: Record<string, unknown>) => void>> }

// Only WebGPU buffer allocation is doubled. Equipment, the selection line system,
// the picker handle and all CPU state execute the real Lite API (no real pick).
function mockEngine(): EngineContext {
  const engine = { _renderingContexts: [], _device: {
    createBuffer({ size }: { size: number }) {
      const data = new ArrayBuffer(size);
      return { getMappedRange: () => data, unmap() {}, destroy() {} };
    },
  } } as unknown as EngineContext;
  Object.assign(engine, { engine });
  return engine;
}
function harness() {
  const engine = mockEngine();
  const scene = createSceneContext(engine, { defaultRenderTask: false });
  const equipment = createLiteEquipment(scene, engine);
  return { engine, scene, equipment, dispose() { disposeScene(scene); } };
}
function fakeCanvas(): FakeCanvas & { dispatch(type: string, event: Record<string, unknown>): void; listenerCount(type: string): number; canvas: HTMLCanvasElement } {
  const listeners = new Map<string, Set<(event: Record<string, unknown>) => void>>();
  const fake: FakeCanvas = { style: { cursor: '' }, rect: { left: 10, top: 20, width: 800, height: 600 }, listeners };
  const dispatch = (type: string, event: Record<string, unknown>) => {
    for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
  };
  const api = {
    ...fake,
    dispatch,
    listenerCount: (type: string) => listeners.get(type)?.size ?? 0,
    addEventListener(type: string, listener: (event: Record<string, unknown>) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener(type: string, listener: (event: Record<string, unknown>) => void) {
      listeners.get(type)?.delete(listener);
    },
    getBoundingClientRect: () => ({ ...fake.rect, right: fake.rect.left + fake.rect.width, bottom: fake.rect.top + fake.rect.height }),
  };
  return Object.assign(api, { canvas: api as unknown as HTMLCanvasElement });
}
async function flush(steps = 8) { for (let index = 0; index < steps; index++) await Promise.resolve(); }
function deferredSeam() {
  const calls: PickCall[] = [];
  const seam: SelectionPickSeam = { pick: (x, y) => new Promise(resolve => calls.push({ x, y, resolve })) };
  const resolve = async (index: number, value: { toolIndex: number; x: number; y: number } | null) => {
    calls[index].resolve(value);
    await flush();
  };
  return { seam, calls, resolve };
}
function recordingCallbacks() {
  const picks: (PickedTool | null)[] = [];
  const hovers: (HoveredTool | null)[] = [];
  const focus: number[] = [];
  const callbacks: LiteSelectionCallbacks = {
    onPick: tool => picks.push(tool),
    onHover: hover => hovers.push(hover),
    onSelectFocus: index => focus.push(index),
  };
  return { picks, hovers, focus, callbacks };
}
function selectionWith(harnessed: ReturnType<typeof harness>, options: Partial<Parameters<typeof createLiteSelection>[2]> = {}) {
  return createLiteSelection(harnessed.scene, harnessed.engine, { equipment: harnessed.equipment, ...options });
}
function bind(selection: LiteSelection, canvas: ReturnType<typeof fakeCanvas>, callbacks: LiteSelectionCallbacks) {
  return selection.bind(canvas.canvas, callbacks);
}
function expectPickedTool(tool: PickedTool | null | undefined, index: number, state = FAB_TOOL_STATES[index]) {
  const layout = FAB_LAYOUT[index];
  expect(tool).toEqual({
    index, x: layout.x, z: layout.z, width: layout.width, depth: layout.depth, height: layout.height,
    category: layout.category, vendor: layout.vendor, model: layout.model, state,
  });
}
// Mirrors the frozen hierarchy bounds: every authored part, including the status beacon and pole.
function toolWorldBounds(equipment: LiteEquipment, index: number) {
  const min: Triple = [Infinity, Infinity, Infinity], max: Triple = [-Infinity, -Infinity, -Infinity];
  for (const part of equipment.tools[index].parts) {
    const mesh = equipment.batches[part.batchIndex].mesh;
    const geometry = getMeshGeometry(mesh);
    if (!geometry) continue;
    const instance = mesh.thinInstances!.matrices, world = mesh.worldMatrix, offset = part.instanceIndex * 16;
    for (let vertex = 0; vertex < geometry.positions.length; vertex += 3) {
      const x = geometry.positions[vertex], y = geometry.positions[vertex + 1], z = geometry.positions[vertex + 2];
      const ix = instance[offset] * x + instance[offset + 4] * y + instance[offset + 8] * z + instance[offset + 12];
      const iy = instance[offset + 1] * x + instance[offset + 5] * y + instance[offset + 9] * z + instance[offset + 13];
      const iz = instance[offset + 2] * x + instance[offset + 6] * y + instance[offset + 10] * z + instance[offset + 14];
      const point: Triple = [
        world[0] * ix + world[4] * iy + world[8] * iz + world[12],
        world[1] * ix + world[5] * iy + world[9] * iz + world[13],
        world[2] * ix + world[6] * iy + world[10] * iz + world[14],
      ];
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis], point[axis]);
        max[axis] = Math.max(max[axis], point[axis]);
      }
    }
  }
  return { min, max };
}

it('creates the native GPU picker and the legacy wireframe box, recreating the picker on recovery', () => {
  const harnessed = harness();
  const selection = selectionWith(harnessed);
  try {
    const visual = harnessed.scene.meshes.find(mesh => mesh.name === 'tool-selection');
    expect(visual).toBeDefined();
    expect(visual!.visible).toBe(false);
    expect(visual!.pickable).toBe(false);
    expect(selection.picker).toBeDefined();
    const material = visual!.material as LineMaterial;
    expect(material.color).toMatchObject({ r: .05, g: .64, b: .44, a: 1 });
    // Message-level unit box (r128 WireframeGeometry includes each face diagonal).
    const geometry = getMeshGeometry(visual!)!;
    expect(geometry.positions.length).toBe(36 * 3);
    const vertices: Triple[] = [];
    for (let i = 0; i < geometry.positions.length; i += 3) vertices.push([geometry.positions[i], geometry.positions[i + 1], geometry.positions[i + 2]]);
    for (const value of vertices.flat()) expect(Math.abs(value)).toBeCloseTo(.5, 6);
    const edges = [];
    for (let i = 0; i < vertices.length; i += 2) edges.push([vertices[i], vertices[i + 1]] as const);
    const differences = edges.map(([a, b]) => [0, 1, 2].filter(axis => Math.abs(a[axis] - b[axis]) > 1e-9).length);
    expect(differences.filter(count => count === 2)).toHaveLength(6);
    expect(differences.filter(count => count === 1)).toHaveLength(12);

    const first = selection.picker;
    selection.prepareForDeviceRecovery();
    expect(selection.picker).toBeDefined();
    expect(selection.picker).not.toBe(first);
    expect(harnessed.scene.meshes).toContain(visual);

    selection.dispose();
    expect(selection.picker).toBeUndefined();
    expect(harnessed.scene.meshes).not.toContain(visual);
  } finally { selection.dispose(); harnessed.dispose(); }
});

it('restricts candidates to non-decorative equipment batches and resolves thin-instance identity', () => {
  const harnessed = harness();
  const selection = selectionWith(harnessed);
  const resolver = createSelectionPickResolver(harnessed.equipment);
  const decorative = createBox(harnessed.engine);
  addToScene(harnessed.scene, decorative);
  try {
    const first = harnessed.equipment.tools[8];
    const second = harnessed.equipment.tools[10];
    expect(first.recordId).toBe(second.recordId);
    expect(first.instanceId).not.toBe(second.instanceId);
    const partFor = (index: number, role: 'body' | 'wire') => {
      const part = harnessed.equipment.tools[index].parts.find(candidate => candidate.role === role);
      const mesh = harnessed.equipment.batches[part!.batchIndex].mesh;
      return { part: part!, mesh };
    };
    const a = partFor(8, 'body'), b = partFor(10, 'body');
    expect(resolver.filter(a.mesh)).toBe(true);
    expect(resolver.resolve({ hit: true, pickedMesh: a.mesh, thinInstanceIndex: a.part.instanceIndex })).toBe(8);
    expect(resolver.resolve({ hit: true, pickedMesh: b.mesh, thinInstanceIndex: b.part.instanceIndex })).toBe(10);
    const wireToolIndex = harnessed.equipment.tools.findIndex(tool => tool.parts.some(part => part.role === 'wire'));
    expect(wireToolIndex).toBeGreaterThanOrEqual(0);
    const wire = partFor(wireToolIndex, 'wire');
    expect(resolver.filter(wire.mesh)).toBe(false);
    expect(resolver.resolve({ hit: true, pickedMesh: wire.mesh, thinInstanceIndex: wire.part.instanceIndex })).toBeNull();
    expect(resolver.filter(decorative)).toBe(false);
    expect(resolver.resolve({ hit: true, pickedMesh: decorative, thinInstanceIndex: -1 })).toBeNull();
    expect(resolver.resolve({ hit: false, pickedMesh: a.mesh, thinInstanceIndex: a.part.instanceIndex })).toBeNull();
    expect(resolver.resolve({ hit: true, pickedMesh: a.mesh, thinInstanceIndex: 99999 })).toBeNull();
    expect(resolver.filter({} as Mesh)).toBe(false);
  } finally { selection.dispose(); harnessed.dispose(); }
});

it('selects on release within the legacy 6 px threshold, emits legacy PickedTool data and clears on a miss', async () => {
  const harnessed = harness();
  const seam: SelectionPickSeam = { pick: async (x, y) => ({ toolIndex: 5, x, y }) };
  const selection = selectionWith(harnessed, { pick: seam, getToolState: index => index === 5 ? 'maint' : FAB_TOOL_STATES[index] });
  const canvas = fakeCanvas();
  const { picks, callbacks } = recordingCallbacks();
  const unbind = bind(selection, canvas, callbacks);
  try {
    canvas.dispatch('pointerdown', { clientX: 110, clientY: 220 });
    canvas.dispatch('pointerup', { clientX: 111, clientY: 221 });
    await flush();
    expect(picks).toHaveLength(1);
    expectPickedTool(picks[0], 5, 'maint');
    expect(selection.selectedIndex).toBe(5);
    const visual = harnessed.scene.meshes.find(mesh => mesh.name === 'tool-selection')!;
    expect(visual.visible).toBe(true);

    // 7 px of drag is not a click and must not repick.
    canvas.dispatch('pointerdown', { clientX: 110, clientY: 220 });
    canvas.dispatch('pointerup', { clientX: 117, clientY: 220 });
    await flush();
    expect(picks).toHaveLength(1);
    expect(selection.selectedIndex).toBe(5);

    // The legacy clearPickedTool sentinel only emits null when something was selected.
    const miss: SelectionPickSeam = { pick: async () => null };
    const clearing = selectionWith(harnessed, { pick: miss });
    const missCanvas = fakeCanvas();
    const missed = recordingCallbacks();
    const unbindMiss = bind(clearing, missCanvas, missed.callbacks);
    clearing.selectTool(3);
    missCanvas.dispatch('pointerdown', { clientX: 110, clientY: 220 });
    missCanvas.dispatch('pointerup', { clientX: 110, clientY: 220 });
    await flush();
    expect(missed.picks).toHaveLength(2);
    expect(missed.picks[1]).toBeNull();
    expect(clearing.selectedIndex).toBeNull();
    missCanvas.dispatch('pointerdown', { clientX: 110, clientY: 220 });
    missCanvas.dispatch('pointerup', { clientX: 110, clientY: 220 });
    await flush();
    expect(missed.picks).toHaveLength(2);
    unbindMiss(); clearing.dispose();
  } finally { unbind(); selection.dispose(); harnessed.dispose(); }
});

it('throttles hover picks by hoverPickMs, dedupes the index, skips pressed pointers and clears on leave', async () => {
  const harnessed = harness();
  const calls: { x: number; y: number }[] = [];
  const results: (number | null)[] = [3, 3, 4, null];
  let now = 0;
  const seam: SelectionPickSeam = { pick: async (x, y) => {
    calls.push({ x, y });
    const toolIndex = results.shift() ?? null;
    return toolIndex === null ? null : { toolIndex, x: x + 1000, y: y + 2000 };
  } };
  const selection = selectionWith(harnessed, { pick: seam, hoverPickMs: 50, now: () => now });
  const canvas = fakeCanvas();
  const { hovers, callbacks } = recordingCallbacks();
  const unbind = bind(selection, canvas, callbacks);
  try {
    canvas.dispatch('pointermove', { clientX: 110, clientY: 220, buttons: 0 });
    await flush();
    expect(calls).toEqual([{ x: 100, y: 200 }]);
    expect(hovers).toHaveLength(1);
    expect(hovers[0]!.x).toBe(1100);
    expect(hovers[0]!.y).toBe(2200);
    expectPickedTool(hovers[0]!.tool, 3);
    expect(canvas.style.cursor).toBe('pointer');

    now = 25;
    canvas.dispatch('pointermove', { clientX: 111, clientY: 221, buttons: 0 });
    await flush();
    expect(calls).toHaveLength(1);

    now = 50;
    canvas.dispatch('pointermove', { clientX: 112, clientY: 222, buttons: 0 });
    await flush();
    expect(calls).toHaveLength(2);
    expect(hovers).toHaveLength(1);

    now = 200;
    canvas.dispatch('pointermove', { clientX: 113, clientY: 223, buttons: 1 });
    await flush();
    expect(calls).toHaveLength(2);
    expect(canvas.style.cursor).toBe('');

    now = 260;
    canvas.dispatch('pointermove', { clientX: 114, clientY: 224, buttons: 0 });
    await flush();
    expect(calls).toHaveLength(3);
    expect(calls[2]).toEqual({ x: 104, y: 204 });
    expect(hovers).toHaveLength(2);
    expectPickedTool(hovers[1]!.tool, 4);

    canvas.dispatch('pointerleave', {});
    expect(hovers).toHaveLength(3);
    expect(hovers[2]).toBeNull();

    now = 400;
    canvas.dispatch('pointermove', { clientX: 115, clientY: 225, buttons: 0 });
    await flush();
    expect(calls).toHaveLength(4);
    expect(hovers).toHaveLength(3);
  } finally { unbind(); selection.dispose(); harnessed.dispose(); }
});

it('never lets an older hover pick overwrite a newer hover or a pointer leave', async () => {
  const harnessed = harness();
  const { seam, resolve } = deferredSeam();
  let now = 0;
  const selection = selectionWith(harnessed, { pick: seam, hoverPickMs: 50, now: () => now });
  const canvas = fakeCanvas();
  const { hovers, callbacks } = recordingCallbacks();
  const unbind = bind(selection, canvas, callbacks);
  try {
    canvas.dispatch('pointermove', { clientX: 110, clientY: 220, buttons: 0 });
    now = 100;
    canvas.dispatch('pointermove', { clientX: 111, clientY: 221, buttons: 0 });
    await flush();
    expect(selection.selectedIndex).toBeNull();
    await resolve(1, { toolIndex: 4, x: 500, y: 600 });
    expect(hovers).toHaveLength(1);
    expectPickedTool(hovers[0]!.tool, 4);
    await resolve(0, { toolIndex: 3, x: 100, y: 200 });
    expect(hovers).toHaveLength(1);

    now = 300;
    canvas.dispatch('pointermove', { clientX: 112, clientY: 222, buttons: 0 });
    await flush();
    canvas.dispatch('pointerleave', {});
    await resolve(2, { toolIndex: 7, x: 1, y: 2 });
    expect(hovers[hovers.length - 1]).toBeNull();
    expect(hovers).toHaveLength(2);
  } finally { unbind(); selection.dispose(); harnessed.dispose(); }
});

it('emits one pick plus the select-focus callback for a double-click selection', async () => {
  const harnessed = harness();
  const seam: SelectionPickSeam = { pick: async (x, y) => ({ toolIndex: 5, x, y }) };
  const selection = selectionWith(harnessed, { pick: seam });
  const canvas = fakeCanvas();
  const { picks, focus, callbacks } = recordingCallbacks();
  const unbind = bind(selection, canvas, callbacks);
  try {
    canvas.dispatch('dblclick', { clientX: 110, clientY: 220 });
    await flush();
    expect(picks).toHaveLength(1);
    expectPickedTool(picks[0], 5);
    expect(focus).toEqual([5]);
    expect(selection.selectedIndex).toBe(5);
  } finally { unbind(); selection.dispose(); harnessed.dispose(); }
});

it('returns the frozen Next RH focus pose while the camera keeps owning its alpha', () => {
  const harnessed = harness();
  const camera = createArcRotateCamera(.7, 1.1, 30, { x: 0, y: 2, z: 0 });
  harnessed.scene.camera = camera;
  const selection = selectionWith(harnessed);
  try {
    const focus = selection.selectTool(8, true);
    const layout = FAB_LAYOUT[8];
    expect(focus).toBeDefined();
    expect(focus!.target).toEqual([layout.x, Math.min(1.5, layout.height / 2), layout.z]);
    const [px, py, pz] = focus!.position, [tx, ty, tz] = focus!.target;
    const dx = px - tx, dy = py - ty, dz = pz - tz;
    expect(Math.hypot(dx, dy, dz)).toBeCloseTo(58, 6);
    expect(Math.acos(dy / 58)).toBeCloseTo(Math.PI / 3.6, 6);
    expect(Math.atan2(dz, dx)).toBeCloseTo(-camera.alpha, 6);
    expect(selection.selectedIndex).toBe(8);

    const withoutFocus = selection.selectTool(9);
    expect(withoutFocus).toBeUndefined();
    expect(selection.selectedIndex).toBe(9);
    expect(selection.selectTool(-1)).toBeUndefined();
    expect(selection.selectedIndex).toBe(9);
  } finally { selection.dispose(); harnessed.dispose(); }
});

it('frames the selection with the legacy world-space hierarchy bounds plus the 0.2 margin', () => {
  const harnessed = harness();
  const selection = selectionWith(harnessed);
  try {
    selection.selectTool(0);
    const visual = harnessed.scene.meshes.find(mesh => mesh.name === 'tool-selection')!;
    const expected = toolWorldBounds(harnessed.equipment, 0);
    expect(visual.visible).toBe(true);
    const axes = ['x', 'y', 'z'] as const;
    axes.forEach((axis, index) => {
      expect(visual.position[axis]).toBeCloseTo((expected.min[index] + expected.max[index]) / 2, 5);
      expect(visual.scaling[axis]).toBeCloseTo(expected.max[index] - expected.min[index] + .2, 5);
    });
    // The frozen hierarchy bounds include the status beacon above the tool body.
    expect(expected.max[1]).toBeGreaterThan(FAB_LAYOUT[0].height + .3);
    selection.clear();
    expect(visual.visible).toBe(false);
  } finally { selection.dispose(); harnessed.dispose(); }
});

it('ignores picks that resolve after a newer selection, a clear or disposal', async () => {
  const harnessed = harness();
  const { seam, resolve } = deferredSeam();
  const selection = selectionWith(harnessed, { pick: seam });
  const canvas = fakeCanvas();
  const { picks, callbacks } = recordingCallbacks();
  const unbind = bind(selection, canvas, callbacks);
  try {
    canvas.dispatch('pointerdown', { clientX: 110, clientY: 220 });
    canvas.dispatch('pointerup', { clientX: 110, clientY: 220 });
    canvas.dispatch('pointerdown', { clientX: 110, clientY: 220 });
    canvas.dispatch('pointerup', { clientX: 110, clientY: 220 });
    await flush();
    expect(harnessed.scene.meshes).toContain(harnessed.scene.meshes.find(mesh => mesh.name === 'tool-selection')!);
    expect(selection.selectedIndex).toBeNull();
    await resolve(1, { toolIndex: 4, x: 0, y: 0 });
    expect(picks).toHaveLength(1);
    expectPickedTool(picks[0], 4);
    expect(selection.selectedIndex).toBe(4);
    await resolve(0, { toolIndex: 3, x: 0, y: 0 });
    expect(picks).toHaveLength(1);
    expect(selection.selectedIndex).toBe(4);

    // clear() invalidates an in-flight click and suppresses the repeat null emission.
    canvas.dispatch('pointerdown', { clientX: 110, clientY: 220 });
    canvas.dispatch('pointerup', { clientX: 110, clientY: 220 });
    await flush();
    selection.clear();
    expect(picks).toHaveLength(2);
    expect(picks[1]).toBeNull();
    await resolve(2, { toolIndex: 6, x: 0, y: 0 });
    expect(picks).toHaveLength(2);
    expect(selection.selectedIndex).toBeNull();

    // A programmatic selection wins over an older in-flight click.
    canvas.dispatch('pointerdown', { clientX: 110, clientY: 220 });
    canvas.dispatch('pointerup', { clientX: 110, clientY: 220 });
    await flush();
    selection.selectTool(7);
    expect(picks).toHaveLength(3);
    await resolve(3, { toolIndex: 2, x: 0, y: 0 });
    expect(picks).toHaveLength(3);
    expectPickedTool(picks[2], 7);
    expect(selection.selectedIndex).toBe(7);

    // prepareForDeviceRecovery invalidates old-device picks and replaces the picker.
    canvas.dispatch('pointerdown', { clientX: 110, clientY: 220 });
    canvas.dispatch('pointerup', { clientX: 110, clientY: 220 });
    await flush();
    expect(selection.picker).toBeUndefined();
    selection.prepareForDeviceRecovery();
    expect(selection.picker).toBeUndefined();
    await resolve(4, { toolIndex: 1, x: 0, y: 0 });
    expect(picks).toHaveLength(3);

    // dispose() detaches listeners and drops late results.
    canvas.dispatch('pointerdown', { clientX: 110, clientY: 220 });
    canvas.dispatch('pointerup', { clientX: 110, clientY: 220 });
    await flush();
    selection.dispose();
    expect(canvas.listenerCount('pointerup')).toBe(0);
    expect(canvas.listenerCount('pointermove')).toBe(0);
    expect(canvas.listenerCount('dblclick')).toBe(0);
    await resolve(5, { toolIndex: 2, x: 0, y: 0 });
    expect(picks).toHaveLength(3);
    unbind();
  } finally { selection.dispose(); harnessed.dispose(); }
});

it('disables picking in basement-like modes and keeps the selection through a transient pick failure', async () => {
  const harnessed = harness();
  let fail = false;
  const seam: SelectionPickSeam = { pick: async (x, y) => {
    if (fail) throw new Error('device lost');
    return { toolIndex: 5, x, y };
  } };
  const selection = selectionWith(harnessed, { pick: seam });
  const canvas = fakeCanvas();
  const { picks, hovers, callbacks } = recordingCallbacks();
  const unbind = bind(selection, canvas, callbacks);
  try {
    selection.selectTool(5);
    expect(picks).toHaveLength(1);
    selection.setPickingEnabled(false);
    canvas.dispatch('pointerdown', { clientX: 110, clientY: 220 });
    canvas.dispatch('pointerup', { clientX: 110, clientY: 220 });
    await flush();
    expect(picks).toHaveLength(2);
    expect(picks[1]).toBeNull();
    expect(selection.selectedIndex).toBeNull();
    canvas.dispatch('pointermove', { clientX: 110, clientY: 220, buttons: 0 });
    await flush();
    expect(hovers).toHaveLength(0);

    selection.selectTool(5);
    selection.setPickingEnabled(true);
    fail = true;
    canvas.dispatch('pointerdown', { clientX: 110, clientY: 220 });
    canvas.dispatch('pointerup', { clientX: 110, clientY: 220 });
    await flush();
    expect(selection.selectedIndex).toBe(5);
    expect(picks).toHaveLength(3);
  } finally { unbind(); selection.dispose(); harnessed.dispose(); }
});

