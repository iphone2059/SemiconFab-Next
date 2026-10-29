import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
vi.hoisted(() => Object.assign(globalThis, { GPUBufferUsage: { VERTEX: 32, INDEX: 16, COPY_DST: 8 },
  GPUTextureUsage: { TEXTURE_BINDING: 4, COPY_DST: 2, RENDER_ATTACHMENT: 16 } }));
import { createSceneContext, disposeScene, getMeshGeometry, setParent, createTransformNode, setSubtreeVisible,
  type EngineContext, type Mesh } from '@babylonjs/lite';
import { createLiteMotion, createLiteMotionArc, locateLiteMotionArcPoint } from '@/rendering/lite-motion';
import { advanceAmhsState, createAmhsRandom, createAmhsState } from '@/domain/amhs-timeline';

const personnel = JSON.parse(readFileSync(new URL('../fixtures/original-personnel-vectors.json', import.meta.url), 'utf8'));
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

/** @internal GPU-sync bookkeeping that the public ThinInstanceData type does not expose. */
type ThinInstanceInternals = {
  matrices: Float32Array | Float64Array; count: number; _capacity: number;
  _version: number; _dirtyMin: number; _dirtyMax: number;
};
function internals(mesh: Mesh): ThinInstanceInternals {
  const data = mesh.thinInstances;
  if (!data) throw new Error(`mesh "${mesh.name}" is not thin-instanced`);
  return data as unknown as ThinInstanceInternals;
}
function poolMesh(model: ReturnType<typeof createLiteMotion>, name: string): Mesh {
  const mesh = model.meshes.find(candidate => candidate.name === name);
  if (!mesh) throw new Error(`missing thin-instance pool "${name}"`);
  return mesh;
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
        total: 24, queued: expected.queue.length, completed: expected.completedCount,
        avgDelivery: expected.completedCount ? expected.totalDeliveryTime / expected.completedCount : null });
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

it('retains root-relative instance transforms under reflection and disposal', () => {
  const h = harness();
  try {
    const reflected = createTransformNode('frame'); reflected.scaling.z = -1;
    setParent(h.model.root, reflected);
    h.model.update(16, 16);
    const before = h.model.readSnapshot();
    expect(h.model.readSnapshot()).toEqual(before);
    h.model.dispose(); h.model.dispose(); h.model.update(16, 32);
    expect(h.model.readSnapshot()).toEqual(before);
  } finally { h.dispose(); }
});

it('keeps a static thin-instance pool version and dirty window untouched across repeated projections', () => {
  const h = harness();
  try {
    h.model.update(16, 16);
    const support = poolMesh(h.model, 'motion-batch-support');
    const data = internals(support);
    expect(data.count).toBe(44);
    expect(data._capacity).toBe(44);
    const version = data._version, dirtyMin = data._dirtyMin, dirtyMax = data._dirtyMax;
    const matrices = Array.from(data.matrices);
    for (let tick = 2; tick <= 12; tick++) h.model.update(16, tick * 16);
    expect(internals(support)._version).toBe(version);
    expect(internals(support)._dirtyMin).toBe(dirtyMin);
    expect(internals(support)._dirtyMax).toBe(dirtyMax);
    expect(Array.from(internals(support).matrices)).toEqual(matrices);
  } finally { h.dispose(); }
});

it('uploads only the changed instance slots while a pool population is stable', () => {
  const h = harness();
  try {
    // Warm up into live traffic so the LED colour pools hold partial populations.
    for (let tick = 1; tick <= 160; tick++) h.model.update(1000 / 60, tick * 1000 / 60);
    const meshes = h.model.meshes.filter(mesh => mesh.thinInstances);
    let stableFrames = 0, partialWrites = 0;
    for (let tick = 161; tick <= 200; tick++) {
      const snapshots = meshes.map(mesh => {
        const data = internals(mesh);
        return { mesh, data, count: data.count, version: data._version, matrices: Array.from(data.matrices) };
      });
      // Match the render system, which resets the dirty window to [count, 0) after a GPU sync.
      for (const snapshot of snapshots) { snapshot.data._dirtyMin = snapshot.count; snapshot.data._dirtyMax = 0; }
      h.model.update(1000 / 60, tick * 1000 / 60);
      for (const snapshot of snapshots) {
        const { data } = snapshot;
        if (data.count !== snapshot.count) continue; // population changes re-upload the whole active range (next test)
        let changed = 0, dirtyMin = data.count, dirtyMax = 0;
        for (let slot = 0; slot < data.count; slot++) {
          const offset = slot * 16;
          for (let lane = 0; lane < 16; lane++) {
            if (snapshot.matrices[offset + lane] === data.matrices[offset + lane]) continue;
            changed += 1; dirtyMin = Math.min(dirtyMin, slot); dirtyMax = Math.max(dirtyMax, slot + 1); break;
          }
        }
        stableFrames += 1;
        // One setThinInstanceMatrix bump per changed slot, and no bump at all for identical frames.
        expect(data._version - snapshot.version, snapshot.mesh.name).toBe(changed);
        expect(data._dirtyMin, snapshot.mesh.name).toBe(changed ? dirtyMin : data.count);
        expect(data._dirtyMax, snapshot.mesh.name).toBe(dirtyMax);
        if (changed > 0 && data.count < data._capacity) {
          partialWrites += 1;
          // A partial pool never marks the whole capacity dirty for its active instances.
          expect(dirtyMax, snapshot.mesh.name).toBeLessThanOrEqual(data.count);
        }
      }
    }
    expect(stableFrames).toBeGreaterThan(0);
    expect(partialWrites).toBeGreaterThan(0);
  } finally { h.dispose(); }
});

it('keeps the full active-range upload on frames where a pool population changes', () => {
  const h = harness();
  try {
    const meshes = h.model.meshes.filter(mesh => mesh.thinInstances);
    let observed = false;
    for (let tick = 1; tick <= 400 && !observed; tick++) {
      const snapshots = meshes.map(mesh => {
        const data = internals(mesh);
        return { data, count: data.count, version: data._version };
      });
      for (const snapshot of snapshots) { snapshot.data._dirtyMin = snapshot.count; snapshot.data._dirtyMax = 0; }
      h.model.update(1000 / 60, tick * 1000 / 60);
      for (const snapshot of snapshots) {
        if (snapshot.data.count === snapshot.count) continue;
        expect(snapshot.data._version).toBeGreaterThan(snapshot.version);
        expect(snapshot.data._dirtyMin).toBe(0);
        expect(snapshot.data._dirtyMax).toBe(snapshot.data.count);
        observed = true;
      }
    }
    expect(observed).toBe(true);
  } finally { h.dispose(); }
});

it('keeps the rendered instance order, count and world matrices identical to the pose nodes', () => {
  const h = harness();
  try {
    for (let tick = 1; tick <= 30; tick++) h.model.update(16, tick * 16);
    const body = poolMesh(h.model, 'motion-batch-body');
    const data = internals(body);
    const poses = h.model.readVehiclePositions();
    expect(data.count).toBe(poses.length);
    const members = h.model.parts.filter(part => part.mesh === body)
      .sort((left, right) => left.instanceIndex - right.instanceIndex);
    expect(members).toHaveLength(data.count);
    members.forEach((part, slot) => {
      expect(part.instanceIndex).toBe(slot);
      const matrix = part.node.worldMatrix;
      for (let lane = 0; lane < 16; lane++) expect(data.matrices[slot * 16 + lane]).toBe(matrix[lane]);
      for (let axis = 0; axis < 3; axis++) expect(matrix[12 + axis]).toBeCloseTo(poses[slot].position[axis], 5);
    });
  } finally { h.dispose(); }
});

// ---------------------------------------------------------------------------------------------
// A14/B01-B03 wave: frozen projection vectors, arc-boundary sweep and hidden-AMHS projection.
// ---------------------------------------------------------------------------------------------

const arcVectors = JSON.parse(readFileSync(new URL('../fixtures/original-motion-arc-vectors.json', import.meta.url), 'utf8')) as {
  loopLengths: number[];
  ticks: number[];
  samples: { tick: number; vehicles: number[][] }[];
};

/**
 * Independent copy of the pre-wave linear arc-length scan (motion.ts before B02). The binary
 * locator must return bit-identical interpolation inputs for every boundary and offset.
 */
function referenceArcPoint(arc: { positions: { x: number; y: number; z: number }[]; cumulative: number[]; total: number },
  progress: number): { index: number; x: number; z: number } {
  const target = ((progress % 1 + 1) % 1) * arc.total;
  let index = 1;
  while (index < 512 && arc.cumulative[index] < target) index++;
  const segment = arc.cumulative[index] - arc.cumulative[index - 1];
  const t = segment > 0 ? (target - arc.cumulative[index - 1]) / segment : 0;
  return {
    index,
    x: arc.positions[index - 1].x + (arc.positions[index].x - arc.positions[index - 1].x) * t,
    z: arc.positions[index - 1].z + (arc.positions[index].z - arc.positions[index - 1].z) * t,
  };
}

it('locates every arc sample boundary exactly like the removed linear scan', () => {
  const loops = [
    [[-33, -27], [26, -27], [42, -27], [42, 28], [18, 28], [-5, 28], [-33, 28]],
    [[-27, -24], [20, -24], [20, 25], [-4, 25], [-4, -24]],
  ] as const;
  const out = { x: 0, y: 0, z: 0 };
  loops.forEach((points, loopIndex) => {
    const arc = createLiteMotionArc(points);
    // The seam uses the product arc constants, not a synthetic curve.
    expect(arc.total).toBeCloseTo(arcVectors.loopLengths[loopIndex], 10);
    expect(arc.cumulative).toHaveLength(513);
    const visited = new Set<number>();
    const check = (progress: number): void => {
      locateLiteMotionArcPoint(arc, progress, out);
      const expected = referenceArcPoint(arc, progress);
      visited.add(expected.index);
      expect([out.x, out.z], `progress ${progress}`).toEqual([expected.x, expected.z]);
      expect(out.y).toBe(0);
    };
    for (let index = 1; index <= 512; index++) {
      const boundary = arc.cumulative[index] / arc.total;
      check(boundary);
      check(boundary - 1e-12 / arc.total);
      check(boundary + 1e-12 / arc.total);
      if (index > 1) check((arc.cumulative[index - 1] + arc.cumulative[index]) / 2 / arc.total);
    }
    for (let step = 0; step < 2048; step++) check(step / 2048);
    for (const edge of [0, 1e-15, 0.5, 1 - 1e-15, 0.9999999999999999]) check(edge);
    // Every one of the 512 interpolation segments is actually exercised.
    expect(visited.size).toBe(512);
  });
});

it('keeps the frozen vehicle projection vectors at every sampled source tick', () => {
  const h = harness();
  try {
    const sampleNow = () => h.model.readVehiclePositions().map(vehicle =>
      [vehicle.position[0], vehicle.position[1], vehicle.position[2], vehicle.rotationY, vehicle.hoistY,
        vehicle.foupVisible ? 1 : 0]);
    const expectedByTick = new Map(arcVectors.samples.map(sample => [sample.tick, sample.vehicles]));
    expect(arcVectors.samples[0].tick).toBe(0);
    expect(sampleNow()).toEqual(arcVectors.samples[0].vehicles);
    for (let tick = 1; tick <= 3600; tick++) {
      h.model.update(1000 / 60, tick * 1000 / 60);
      const expected = expectedByTick.get(tick);
      if (expected) expect(sampleNow(), `tick ${tick}`).toEqual(expected);
    }
  } finally { h.dispose(); }
});

it('shares one read-only personnel snapshot per frame with the facility air-shower reader', () => {
  const h = harness();
  try {
    h.model.update(16, 16);
    const frame = h.model.readSnapshot().personnel;
    // B03: the facility callback and the state readout consume the exact frame motion already read.
    expect(h.model.readAirShowerFrames()).toBe(frame.airShowers);
    expect(h.model.readAirShowerFrames()).toBe(h.model.readAirShowerFrames());
    h.model.update(16, 32);
    expect(h.model.readAirShowerFrames()).toBe(h.model.readSnapshot().personnel.airShowers);
    expect(h.model.readSnapshot().personnel.tick).toBeGreaterThan(frame.tick);
  } finally { h.dispose(); }
});

it('keeps the hidden AMHS simulation identical while skipping instance projection and restores it on re-show', () => {
  const hidden = harness();
  const visible = harness();
  try {
    setSubtreeVisible(hidden.model.amhsRoot, false);
    const poolSnapshots = hidden.model.meshes.filter(mesh => mesh.thinInstances).map(mesh => {
      const data = internals(mesh);
      return { mesh, version: data._version, count: data.count, capacity: data._capacity,
        dirtyMin: data._dirtyMin, dirtyMax: data._dirtyMax, matrices: Array.from(data.matrices) };
    });
    expect(poolSnapshots.length).toBeGreaterThan(8);
    const simulationBefore = hidden.model.readSnapshot();

    for (let tick = 1; tick <= 600; tick++) {
      hidden.model.update(1000 / 60, tick * 1000 / 60);
      visible.model.update(1000 / 60, tick * 1000 / 60);
      if (tick % 60 === 0) {
        // (a) hidden still advances the same simulation as the always-visible reference.
        expect(hidden.model.readSnapshot()).toEqual(visible.model.readSnapshot());
        expect(hidden.model.readStats()).toEqual(visible.model.readStats());
      }
    }
    const simulationAfter = hidden.model.readSnapshot();
    expect(simulationAfter.simTime).toBeGreaterThan(simulationBefore.simTime);
    expect(simulationAfter.vehicles.some((vehicle, index) => vehicle.s !== simulationBefore.vehicles[index].s)).toBe(true);
    expect(hidden.model.readStats()).toEqual(visible.model.readStats());

    // (b) no per-instance matrix comparison/upload runs while the layer is hidden.
    for (const snapshot of poolSnapshots) {
      const data = internals(snapshot.mesh);
      expect(data._version, snapshot.mesh.name).toBe(snapshot.version);
      expect(data.count, snapshot.mesh.name).toBe(snapshot.count);
      expect(data._capacity, snapshot.mesh.name).toBe(snapshot.capacity);
      expect(data._dirtyMin, snapshot.mesh.name).toBe(snapshot.dirtyMin);
      expect(data._dirtyMax, snapshot.mesh.name).toBe(snapshot.dirtyMax);
      expect(Array.from(data.matrices), snapshot.mesh.name).toEqual(snapshot.matrices);
    }

    // (c) re-showing forces a full population/matrix rebuild that matches the visible reference.
    setSubtreeVisible(hidden.model.amhsRoot, true);
    hidden.model.update(1000 / 60, 601 * 1000 / 60);
    visible.model.update(1000 / 60, 601 * 1000 / 60);
    expect(hidden.model.readSnapshot()).toEqual(visible.model.readSnapshot());
    const visiblePools = new Map(visible.model.meshes.filter(mesh => mesh.thinInstances).map(mesh => [mesh.name, mesh]));
    for (const mesh of hidden.model.meshes.filter(candidate => candidate.thinInstances)) {
      const reference = visiblePools.get(mesh.name);
      expect(reference, mesh.name).toBeTruthy();
      const data = internals(mesh), expected = internals(reference!);
      const baseline = poolSnapshots.find(snapshot => snapshot.mesh.name === mesh.name)!;
      expect(data.count, mesh.name).toBe(expected.count);
      // Only the active draw prefix is part of the rendered state; slots above the count are
      // stale by design (incremental upload keeps the last written value of an enabled slot).
      expect(Array.from(data.matrices.slice(0, data.count * 16)), mesh.name)
        .toEqual(Array.from(expected.matrices.slice(0, expected.count * 16)));
      // The rebuild publishes the whole active range: count write bumps the version and dirties [0, count).
      expect(data._version, mesh.name).toBeGreaterThan(baseline.version);
      expect(data._dirtyMin, mesh.name).toBe(0);
      expect(data._dirtyMax, mesh.name).toBe(data.count);
    }
  } finally { hidden.dispose(); visible.dispose(); }
});
