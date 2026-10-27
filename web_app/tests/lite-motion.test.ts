import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
vi.hoisted(() => Object.assign(globalThis, { GPUBufferUsage: { VERTEX: 32, INDEX: 16, COPY_DST: 8 },
  GPUTextureUsage: { TEXTURE_BINDING: 4, COPY_DST: 2, RENDER_ATTACHMENT: 16 } }));
import { createSceneContext, disposeScene, getMeshGeometry, setParent, createTransformNode, setSubtreeVisible,
  type EngineContext, type Mesh } from '@babylonjs/lite';
import { createLiteMotion } from '../src/rendering/lite/motion';
import { advanceAmhsState, createAmhsRandom, createAmhsState } from '../src/amhs-timeline';

const personnel = JSON.parse(readFileSync(new URL('./fixtures/original-personnel-vectors.json', import.meta.url), 'utf8'));
function harness() {
  const buffers: { destroyed: boolean }[] = [];
  const engine = { _renderingContexts: [], _device: { createBuffer({ size }: { size: number }) {
    const data = new ArrayBuffer(size), record = { destroyed: false }; buffers.push(record);
    return { getMappedRange: () => data, unmap() {}, destroy() { record.destroyed = true; } };
  } } } as unknown as EngineContext;
  Object.assign(engine, { engine });
  const scene = createSceneContext(engine, { defaultRenderTask: false });
  const model = createLiteMotion(scene, engine);
  return { model, scene, buffers, dispose() { model.dispose(); disposeScene(scene); } };
}
function dimensions(mesh: Mesh) {
  const p = getMeshGeometry(mesh)!.positions;
  return [0, 1, 2].map(a => {
    let lo = Infinity, hi = -Infinity;
    for (let i = a; i < p.length; i += 3) { lo = Math.min(lo, p[i]); hi = Math.max(hi, p[i]); }
    return hi - lo;
  });
}

it('retains all source AMHS parts and exact source geometry measurements with native batching', () => {
  const h = harness();
  try {
    const parts = h.model.parts;
    const count = (prefix: string) => parts.filter(p => p.name.startsWith(prefix)).length;
    expect(count('native-oht-rail-')).toBe(2);
    expect(count('native-oht-support-')).toBe(44);
    expect(parts.filter(p => /^native-oht-\d-\d+$/.test(p.name))).toHaveLength(24);
    for (const prefix of ['light', 'beacon', 'hoist', 'foup', 'shadow']) expect(count('native-oht-' + prefix + '-')).toBe(24);
    expect(count('native-oht-wheel-')).toBe(96);
    expect(count('native-oht-cable-')).toBe(48);
    const measurements: [string, number[]][] = [
      ['native-oht-0-0', [1.6, 0.45, 0.95]], ['native-oht-light-0-0', [0.8, 0.06, 0.12]],
      ['native-oht-hoist-0-0', [0.16, 0.55, 0.16]], ['native-oht-foup-0-0', [0.55, 0.42, 0.55]],
      ['native-oht-cable-0-0-0', [0.024, 0.5, 0.024 * Math.sqrt(3) / 2]],
      ['native-oht-shadow-0-0', [2.4, 0, 1.6]],
    ];
    for (const [name, size] of measurements) {
      const part = parts.find(p => p.name === name)!;
      expect(part, name).toBeDefined();
      dimensions(part.mesh).forEach((d, axis) => expect(d, name).toBeCloseTo(size[axis], 6));
    }
    expect(h.model.amhsRoot.parent).toBe(h.model.root);
    expect(h.model.personnelRoot.parent).toBe(h.model.root);
    expect(h.model.meshes.filter(m => m.thinInstances).length).toBeGreaterThan(8);
    expect(h.model.meshes.length).toBeLessThan(150);
    expect(h.model.meshes.every(m => m.pickable === false)).toBe(true);
    expect(h.model.meshes.every(m => h.scene.meshes.includes(m))).toBe(true);
    expect(h.model.lights).toHaveLength(0);
  } finally { h.dispose(); }
});

it('keeps source rail arc/station placement and initial right handed vehicle poses', () => {
  const h = harness();
  try {
    const snapshot = h.model.readSnapshot();
    expect(snapshot.loops.map(loop => loop.stations.map(s => s.s))).toEqual([
      [28, 52.5, 88, 112, 153, 176, 245], [0, 28, 55, 86, 112, 132, 162.5],
    ]);
    expect(snapshot.vehicles).toHaveLength(24);
    const first = h.model.parts.find(p => p.name === 'native-oht-0-0')!;
    Array.from(first.node.worldMatrix).slice(12, 15).forEach((value, i) => expect(value).toBeCloseTo([-33, 5.8, -27][i], 6));
    const second = h.model.parts.find(p => p.name === 'native-oht-1-0')!;
    Array.from(second.node.worldMatrix).slice(12, 15).forEach((value, i) => expect(value).toBeCloseTo([-27, 5.8, -24][i], 6));
    for (const loop of snapshot.loops) expect(loop.samples).toBe(513);
    // Evaluated independently from legacy-site's original Vector3/buildArc source, before removal.
    expect(snapshot.loops[0].length).toBeCloseTo(261.642382244552, 10);
    expect(snapshot.loops[1].length).toBeCloseTo(193.47158503491087, 10);
    expect(h.model.readStats()).toEqual({ active: 0, total: 24, queued: 0, completed: 0, avgDelivery: null });
  } finally { h.dispose(); }
});

it('maps the seeded source traffic clock onto every vehicle without a second simulation clock', () => {
  const h = harness();
  try {
    const lengths = [261.642382244552, 193.47158503491087];
    const makeStations = (loopId: 1 | 2, values: number[]) => values.map((s, i) => ({
      id: `L${loopId}-ST${String(i + 1).padStart(2, '0')}`, loopId, s, bay: '', bayName: '', bayNameZh: '',
    }));
    const expected = createAmhsState({ loops: {
      1: { length: lengths[0], stations: makeStations(1, [28, 52.5, 88, 112, 153, 176, 245]) },
      2: { length: lengths[1], stations: makeStations(2, [0, 28, 55, 86, 112, 132, 162.5]) },
    }, initialNextTaskTime: 1, vehicles: [1, 2].flatMap(id => Array.from({ length: 12 }, (_, i) => ({
      loopId: id as 1 | 2, s: i / 12 * lengths[id - 1],
    }))) });
    const random = createAmhsRandom(42).random;
    for (let tick = 0; tick < 7200; tick++) {
      advanceAmhsState(expected, 1 / 60, random);
      h.model.update(1000 / 60, tick * 1000 / 60);
      if (tick % 120) continue;
      const actual = h.model.readSnapshot();
      actual.vehicles.forEach((vehicle, i) => {
        const source = expected.vehicles[i];
        expect(vehicle.state).toBe(source.state);
        expect(vehicle.s).toBeCloseTo(source.s, 8);
        expect(vehicle.speed).toBeCloseTo(source.speed, 8);
        expect(vehicle.hoistY).toBeCloseTo(source.hoistY, 8);
        expect(vehicle.cableScaleY).toBeCloseTo(source.cableScaleY, 8);
        expect(vehicle.cableY).toBeCloseTo(source.cableY, 8);
        expect(vehicle.foupVisible).toBe(source.foupVisible);
        expect(vehicle.ledHex).toBe(source.ledHex);
      });
      expect(h.model.readStats()).toEqual({ active: expected.vehicles.filter(v => v.state !== 'IDLE').length,
        total: 24, queued: expected.queue.length, completed: expected.completed.length,
        avgDelivery: expected.completed.length ? expected.totalDeliveryTime / expected.completed.length : null });
    }
  } finally { h.dispose(); }
});

it('releases the creator texture if native texture upload fails during partial construction', () => {
  const texture = { mipLevelCount: 7, createView() { return {}; }, destroy: vi.fn() };
  const createTexture = vi.fn(() => texture);
  const engine = { _renderingContexts: [], _device: { createTexture, createSampler: () => ({}),
    queue: { copyExternalImageToTexture() { throw new Error('injected texture upload failure'); } } } } as unknown as EngineContext;
  Object.assign(engine, { engine });
  const scene = createSceneContext(engine, { defaultRenderTask: false });
  vi.stubGlobal('document', { createElement: () => ({ getContext: () => ({ createRadialGradient: () => ({ addColorStop() {} }), fillRect() {} }) }) });
  try {
    expect(() => createLiteMotion(scene, engine)).toThrow('injected texture upload failure');
    expect(createTexture).toHaveBeenCalledWith(expect.objectContaining({ mipLevelCount: 7 }));
    expect(texture.destroy).toHaveBeenCalledTimes(1);
    disposeScene(scene);
    expect(texture.destroy).toHaveBeenCalledTimes(1);
  } finally { vi.unstubAllGlobals(); }
});

it('matches all frozen personnel keyframes and shares their air shower clock', () => {
  const h = harness();
  try {
    const expected = personnel.modes['as-built'].frames;
    expect(h.model.readSnapshot().personnel).toEqual(expected[0]);
    for (let tick = 1; tick <= 3500; tick++) {
      h.model.update(16, tick * 16);
      if (tick % 20) continue;
      const frame = expected.find((f: { tick: number }) => f.tick === tick);
      expect(h.model.readSnapshot().personnel).toEqual(frame);
      expect(h.model.readAirShowerFrames()).toEqual(frame.airShowers);
      const patrol = frame.actors[5];
      expect(h.model.patrolPosition()).toEqual([patrol.x, patrol.y, patrol.z]);
      const node = h.model.patrolRoot;
      expect([node.position.x, node.position.y, node.position.z]).toEqual([patrol.x, patrol.y, patrol.z]);
    }
    expect(h.model.parts.filter(p => p.name.startsWith('operator-'))).toHaveLength(96);
  } finally { h.dispose(); }
});

it('uses one capped fixed 16ms personnel clock while source AMHS advances per render delta', () => {
  const h = harness();
  try {
    h.model.update(8, 20000); expect(h.model.readSnapshot().personnel.tick).toBe(0);
    h.model.update(8, 20008); expect(h.model.readSnapshot().personnel.tick).toBe(1);
    h.model.update(10000, 30008); expect(h.model.readSnapshot().personnel.tick).toBe(9);
    expect(h.model.readSnapshot().simTime).toBeCloseTo(0.116, 9);
    h.model.update(Number.NaN, 30009); h.model.update(-1, 30010);
    expect(h.model.readSnapshot().personnel.tick).toBe(9);
    expect(h.model.readSnapshot().simTime).toBeCloseTo(0.116, 9);
  } finally { h.dispose(); }
});

it('projects source hoist/cable/FOUP/LED states and preserves AMHS hidden state during updates', () => {
  const h = harness();
  try {
    setSubtreeVisible(h.model.amhsRoot, false);
    let lowered = false, carried = false, completed = false, returnedIdle = false;
    const changed = new Set<number>();
    const previousLed = Array(24).fill(0x10b981);
    for (let tick = 0; tick < 12000; tick++) {
      h.model.update(1000 / 60, tick * 1000 / 60);
      if (tick % 30) continue;
      const snapshot = h.model.readSnapshot();
      for (const vehicle of snapshot.vehicles) {
        if (previousLed[vehicle.id] !== vehicle.ledHex) changed.add(vehicle.id);
        previousLed[vehicle.id] = vehicle.ledHex;
        const suffix = `${vehicle.loopId - 1}-${vehicle.id % 12}`;
        const hoist = h.model.parts.find(p => p.name === 'native-oht-hoist-' + suffix)!;
        const cable = h.model.parts.find(p => p.name === 'native-oht-cable-' + suffix + '-0')!;
        const foup = h.model.parts.find(p => p.name === 'native-oht-foup-' + suffix)!;
        expect(hoist.node.position.y).toBeCloseTo(-0.48 + vehicle.hoistY, 10);
        expect(cable.node.position.y).toBeCloseTo(vehicle.cableY - 5.8, 10);
        expect(cable.node.scaling.y).toBe(vehicle.cableScaleY);
        expect(foup.node.visible).toBe(vehicle.foupVisible);
        const light = h.model.parts.find(p => p.name === 'native-oht-light-' + suffix)!;
        const mat = light.mesh.material as { emissiveColor: number[]; specularColor: number[] };
        const intensity = changed.has(vehicle.id) ? 1 : 0.8;
        const expected = [16, 8, 0].map(shift => (vehicle.ledHex >>> shift & 255) / 255 * intensity);
        expect(mat.emissiveColor).toEqual(expected);
        expect(mat.specularColor).toEqual([1, 1, 1]);
        returnedIdle ||= changed.has(vehicle.id) && vehicle.state === 'IDLE';
        lowered ||= vehicle.hoistY < -3;
        carried ||= vehicle.foupVisible;
      }
      completed ||= h.model.readStats().completed > 0;
      if (lowered && carried && completed && returnedIdle) break;
    }
    expect({ lowered, carried, completed }).toEqual({ lowered: true, carried: true, completed: true });
    expect(returnedIdle).toBe(true);
    expect(h.model.amhsRoot.children.every(node => node.visible === false)).toBe(true);
    expect(h.model.readStats().total).toBe(24);
  } finally { h.dispose(); }
});

it('retains root-relative instance transforms under reflection, recovery, language changes and disposal', () => {
  const h = harness();
  try {
    const reflected = createTransformNode('frame'); reflected.scaling.z = -1;
    setParent(h.model.root, reflected);
    h.model.update(16, 16);
    const before = h.model.readSnapshot();
    const pools = h.model.meshes.filter(m => m.thinInstances).map(mesh => ({ mesh, slot: mesh.thinInstances,
      data: Array.from(mesh.thinInstances!.matrices), count: mesh.thinInstances!.count }));
    h.model.prepareForDeviceRecovery();
    for (const pool of pools) {
      expect(pool.mesh.thinInstances).not.toBe(pool.slot);
      expect(Array.from(pool.mesh.thinInstances!.matrices)).toEqual(pool.data);
      expect(pool.mesh.thinInstances!.count).toBe(pool.count);
    }
    h.model.setLanguage('en');
    expect(h.model.readPatrolStatus().text).toBe('Approaching Litho Airlock');
    h.model.setLanguage('zh');
    expect(h.model.readPatrolStatus().text).toBe('正在步向黄光风淋气闸');
    expect(h.model.readSnapshot()).toEqual(before);
    h.model.dispose(); h.model.dispose(); h.model.update(16, 32);
    expect(h.model.readSnapshot()).toEqual(before);
  } finally { h.dispose(); }
});
