import { expect, it, vi } from 'vitest';
vi.hoisted(() => Object.assign(globalThis, {
  GPUBufferUsage: { VERTEX: 32, INDEX: 16, COPY_DST: 8, UNIFORM: 64 },
  GPUTextureUsage: { RENDER_ATTACHMENT: 16, TEXTURE_BINDING: 4 },
}));
import {
  createSceneContext, disposeScene, getPbrEmissiveColor,
  type EngineContext, type PbrMaterialProps,
} from '@babylonjs/lite';
import { FAB_LAYOUT, FAB_TOOL_STATE_META, FAB_TOOL_STATES, type FabToolState } from '../src/fab-layout';
import { createLiteEquipment, type LiteEquipment } from '../src/rendering/lite/geometry/tool-families';
import { createLiteToolStates } from '../src/rendering/lite/tool-states';

const STATE_COLORS: Record<FabToolState, readonly [number, number, number]> = {
  running: [16 / 255, 185 / 255, 129 / 255],
  idle: [245 / 255, 158 / 255, 11 / 255],
  down: [239 / 255, 68 / 255, 68 / 255],
  maint: [59 / 255, 130 / 255, 246 / 255],
};
const PLUGIN_NAME = 'fab-tool-state-lamps';
const BEACON_EMISSIVE_SCALE = { catalog: .85, other: .9 } as const;
const pulse = (nowMs: number) => .6 + .4 * Math.sin(nowMs / 180);

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
function beacon(equipment: LiteEquipment, index: number) {
  const part = equipment.tools[index].parts.find(candidate => candidate.role === 'beacon');
  if (!part) throw new Error('missing beacon part for tool ' + index);
  return { part, mesh: equipment.batches[part.batchIndex].mesh };
}
function colorOf(equipment: LiteEquipment, index: number): [number, number, number, number] {
  const { part, mesh } = beacon(equipment, index);
  const colors = mesh.thinInstances!.colors!;
  const offset = part.instanceIndex * 4;
  return [colors[offset], colors[offset + 1], colors[offset + 2], colors[offset + 3]];
}
function emissiveScale(index: number) {
  return FAB_LAYOUT[index].originalKind === 'catalog' ? BEACON_EMISSIVE_SCALE.catalog : BEACON_EMISSIVE_SCALE.other;
}
function expectColor(actual: readonly number[], expected: readonly number[], alpha: number) {
  expected.forEach((value, axis) => expect(actual[axis], 'channel ' + axis).toBeCloseTo(value, 6));
  expect(actual[3], 'emissive scale').toBeCloseTo(alpha, 6);
}

it('maps all 121 layout identities onto two beacon batches and applies the frozen source colors', () => {
  const harnessed = harness();
  const beaconMeshes = new Set(harnessed.equipment.tools.map((_, index) => beacon(harnessed.equipment, index).mesh));
  const states = createLiteToolStates(harnessed.scene, harnessed.engine, harnessed.equipment);
  try {
    expect(harnessed.equipment.tools).toHaveLength(121);
    expect(beaconMeshes.size).toBe(2);
    let instances = 0;
    for (const tool of harnessed.equipment.tools) {
      expect(tool.parts.filter(part => part.role === 'beacon')).toHaveLength(1);
    }
    for (const mesh of beaconMeshes) {
      instances += mesh.thinInstances!.count;
      const material = mesh.material as PbrMaterialProps;
      expect(material.baseColorFactor).toEqual([1, 1, 1, 1]);
      expect(Array.from(getPbrEmissiveColor(material)!)).toEqual([0, 0, 0]);
      expect(material.plugins?.some(plugin => plugin.name === PLUGIN_NAME)).toBe(true);
      const code = material.plugins!.find(plugin => plugin.name === PLUGIN_NAME)!.getCustomCode?.('fragment')!;
      expect(code.CUSTOM_FRAGMENT_UPDATE_DIFFUSE).toContain('input.vInstanceColor');
      expect(code.CUSTOM_FRAGMENT_BEFORE_LIGHTS).toContain('input.vInstanceColor');
      expect(mesh.thinInstances!.colors).toBeInstanceOf(Float32Array);
    }
    expect(instances).toBe(121);
    // Literal source hex colors are consumed as raw Color3 components (no extra sRGB transform).
    expect(FAB_TOOL_STATE_META.running.color).toBe('#10b981');
    expect(FAB_TOOL_STATE_META.idle.color).toBe('#f59e0b');
    expect(FAB_TOOL_STATE_META.down.color).toBe('#ef4444');
    expect(FAB_TOOL_STATE_META.maint.color).toBe('#3b82f6');
    const seen = new Set<FabToolState>();
    for (let index = 0; index < harnessed.equipment.tools.length; index++) {
      const state = FAB_TOOL_STATES[index];
      seen.add(state);
      expectColor(colorOf(harnessed.equipment, index), STATE_COLORS[state], state === 'down' ? pulse(0) : emissiveScale(index));
    }
    expect([...seen].sort()).toEqual(['down', 'idle', 'maint', 'running']);
    states.dispose();
  } finally { harnessed.dispose(); }
});

it('updates the addressed layout identity only even when the record ids collide', () => {
  const harnessed = harness();
  const states = createLiteToolStates(harnessed.scene, harnessed.engine, harnessed.equipment);
  try {
    const byRecord = new Map<string, number[]>();
    FAB_LAYOUT.forEach((tool, index) => byRecord.set(tool.recordId, [...(byRecord.get(tool.recordId) ?? []), index]));
    const [first, second] = [...byRecord.values()].find(indices => indices.length > 1)!;
    expect(FAB_LAYOUT[first].recordId).toBe(FAB_LAYOUT[second].recordId);
    expect(harnessed.equipment.tools[first].instanceId).not.toBe(harnessed.equipment.tools[second].instanceId);
    const untouched = colorOf(harnessed.equipment, second);
    states.setToolState(first, 'down');
    expectColor(colorOf(harnessed.equipment, first), STATE_COLORS.down, pulse(0));
    expect(colorOf(harnessed.equipment, second)).toEqual(untouched);
    states.setToolState(second, 'maint');
    expectColor(colorOf(harnessed.equipment, second), STATE_COLORS.maint, emissiveScale(second));
    expectColor(colorOf(harnessed.equipment, first), STATE_COLORS.down, pulse(0));
    const invalid = colorOf(harnessed.equipment, 0);
    states.setToolState(-1, 'down');
    states.setToolState(121, 'down');
    states.setToolState(1.5, 'down');
    expect(colorOf(harnessed.equipment, 0)).toEqual(invalid);
  } finally { harnessed.dispose(); }
});

it('never bleeds state between tools sharing one beacon batch', () => {
  const harnessed = harness();
  const states = createLiteToolStates(harnessed.scene, harnessed.engine, harnessed.equipment);
  try {
    const first = 0, second = 1;
    expect(beacon(harnessed.equipment, first).mesh).toBe(beacon(harnessed.equipment, second).mesh);
    const snapshot = new Map(harnessed.equipment.tools.map((_, index) => [index, colorOf(harnessed.equipment, index)]));
    states.setToolState(first, 'down');
    for (let index = 0; index < harnessed.equipment.tools.length; index++) {
      if (index === first) continue;
      expect(colorOf(harnessed.equipment, index), 'tool ' + index).toEqual(snapshot.get(index)!);
    }
    expectColor(colorOf(harnessed.equipment, first), STATE_COLORS.down, pulse(0));
  } finally { harnessed.dispose(); }
});

it('drives the down lamp pulse from absolute time using the frozen period and range', () => {
  const harnessed = harness();
  const states = createLiteToolStates(harnessed.scene, harnessed.engine, harnessed.equipment);
  try {
    const downTools = FAB_TOOL_STATES.map((state, index) => state === 'down' ? index : -1).filter(index => index >= 0);
    const steady = 0;
    expect(downTools.length).toBeGreaterThan(1);
    states.update(16, 0);
    for (const index of downTools) expectColor(colorOf(harnessed.equipment, index), STATE_COLORS.down, .6);
    states.update(16, 180 * Math.PI / 2);
    for (const index of downTools) expectColor(colorOf(harnessed.equipment, index), STATE_COLORS.down, 1);
    states.update(16, 180 * Math.PI);
    for (const index of downTools) expectColor(colorOf(harnessed.equipment, index), STATE_COLORS.down, .6);
    states.update(16, 180 * Math.PI * 1.5);
    for (const index of downTools) expectColor(colorOf(harnessed.equipment, index), STATE_COLORS.down, .2);
    states.update(16, 360 * Math.PI);
    for (const index of downTools) expectColor(colorOf(harnessed.equipment, index), STATE_COLORS.down, .6);
    expectColor(colorOf(harnessed.equipment, steady), STATE_COLORS[FAB_TOOL_STATES[steady]], emissiveScale(steady));
  } finally { harnessed.dispose(); }
});

it('applies per-tool states and full snapshots while preserving every other lamp', () => {
  const harnessed = harness();
  const states = createLiteToolStates(harnessed.scene, harnessed.engine, harnessed.equipment);
  try {
    states.update(0, 42);
    states.setToolState(0, 'down');
    expectColor(colorOf(harnessed.equipment, 0), STATE_COLORS.down, pulse(42));
    states.setToolState(0, 'maint');
    expectColor(colorOf(harnessed.equipment, 0), STATE_COLORS.maint, emissiveScale(0));
    states.setToolState(0, 'idle');
    expectColor(colorOf(harnessed.equipment, 0), STATE_COLORS.idle, emissiveScale(0));
    states.setToolState(0, 'running');
    expectColor(colorOf(harnessed.equipment, 0), STATE_COLORS.running, emissiveScale(0));

    const next = [...FAB_TOOL_STATES];
    next[0] = 'down';
    next[1] = 'maint';
    next[2] = 'idle';
    states.applyAll(next);
    expectColor(colorOf(harnessed.equipment, 0), STATE_COLORS.down, pulse(42));
    expectColor(colorOf(harnessed.equipment, 1), STATE_COLORS.maint, emissiveScale(1));
    expectColor(colorOf(harnessed.equipment, 2), STATE_COLORS.idle, emissiveScale(2));
    expectColor(colorOf(harnessed.equipment, 3), STATE_COLORS[FAB_TOOL_STATES[3]], emissiveScale(3));
    states.update(16, 180 * Math.PI / 2);
    expectColor(colorOf(harnessed.equipment, 0), STATE_COLORS.down, 1);

    const shorter = [...FAB_TOOL_STATES].slice(0, 2);
    shorter[0] = 'running';
    states.applyAll(shorter);
    expectColor(colorOf(harnessed.equipment, 0), STATE_COLORS.running, emissiveScale(0));
    expectColor(colorOf(harnessed.equipment, 2), STATE_COLORS.idle, emissiveScale(2));
  } finally { harnessed.dispose(); }
});

it('reapplies the current thin-instance colors and preserves identity after device recovery', () => {
  const harnessed = harness();
  const states = createLiteToolStates(harnessed.scene, harnessed.engine, harnessed.equipment);
  try {
    const next = [...FAB_TOOL_STATES];
    next[0] = 'down';
    next[10] = 'maint';
    next[100] = 'idle';
    states.applyAll(next);
    const expected = harnessed.equipment.tools.map((_, index) => colorOf(harnessed.equipment, index));
    const beaconMeshes = new Set(harnessed.equipment.tools.map((_, index) => beacon(harnessed.equipment, index).mesh));
    const counts = harnessed.equipment.batches.map(batch => batch.mesh.thinInstances!.count);
    harnessed.equipment.prepareForDeviceRecovery();
    states.prepareForDeviceRecovery();
    states.prepareForDeviceRecovery();
    harnessed.equipment.batches.forEach((batch, index) => {
      expect(batch.mesh.thinInstances!.count).toBe(counts[index]);
      if (beaconMeshes.has(batch.mesh)) expect(batch.mesh.thinInstances!.colors).toBeInstanceOf(Float32Array);
    });
    for (let index = 0; index < harnessed.equipment.tools.length; index++) {
      expect(colorOf(harnessed.equipment, index), 'tool ' + index).toEqual(expected[index]);
      const { part, mesh } = beacon(harnessed.equipment, index);
      expect(harnessed.equipment.resolve(mesh, part.instanceIndex)).toBe(harnessed.equipment.tools[index]);
    }
    for (const mesh of new Set(harnessed.equipment.tools.map((_, index) => beacon(harnessed.equipment, index).mesh))) {
      const material = mesh.material as PbrMaterialProps;
      expect(material.baseColorFactor).toEqual([1, 1, 1, 1]);
      expect(material.plugins?.some(plugin => plugin.name === PLUGIN_NAME)).toBe(true);
    }
    states.update(16, 180 * Math.PI / 2);
    expectColor(colorOf(harnessed.equipment, 0), STATE_COLORS.down, 1);
  } finally { harnessed.dispose(); }
});

it('restores the equipment material when disposed and ignores later state calls', () => {
  const harnessed = harness();
  const mesh = beacon(harnessed.equipment, 0).mesh;
  const material = mesh.material as PbrMaterialProps;
  const originalBaseColor = [...material.baseColorFactor!];
  const originalEmissive = Array.from(getPbrEmissiveColor(material)!);
  const states = createLiteToolStates(harnessed.scene, harnessed.engine, harnessed.equipment);
  try {
    expect(material.baseColorFactor).toEqual([1, 1, 1, 1]);
    expect(material.plugins?.some(plugin => plugin.name === PLUGIN_NAME)).toBe(true);
    states.dispose();
    expect(Array.from(material.baseColorFactor!)).toEqual(originalBaseColor);
    expect(Array.from(getPbrEmissiveColor(material)!)).toEqual(originalEmissive);
    expect(material.plugins?.some(plugin => plugin.name === PLUGIN_NAME) ?? false).toBe(false);
    const before = colorOf(harnessed.equipment, 0);
    states.setToolState(0, 'down');
    states.applyAll([...FAB_TOOL_STATES].map(() => 'down'));
    states.update(16, 0);
    expect(colorOf(harnessed.equipment, 0)).toEqual(before);
    states.prepareForDeviceRecovery();
    states.dispose();
  } finally { harnessed.dispose(); }
});
