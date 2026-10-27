import {
  getPbrEmissiveColor, setPbrEmissive, setThinInstanceColor, setThinInstanceColors, setThinInstances,
  type EngineContext, type MaterialPlugin, type Mesh, type PbrMaterialProps, type SceneContext,
} from '@babylonjs/lite';
import { FAB_LAYOUT, FAB_TOOL_STATE_META, FAB_TOOL_STATES, type FabToolState } from '../../fab-layout';
import type { LiteEquipment } from './geometry/tool-families';

type Triple = [number, number, number];
export interface LiteToolStates {
  setToolState(index: number, state: FabToolState): void;
  applyAll(states: readonly FabToolState[]): void;
  update(deltaMs: number, nowMs: number): void;
  prepareForDeviceRecovery(): void;
  dispose(): void;
}

const LAMP_PLUGIN = 'fab-tool-state-lamps';
// Frozen source values: legacy-site.ts addToolStatusLights. Colors are the raw Color3
// components of FAB_TOOL_STATE_META hex strings (no extra sRGB conversion) and the
// emissive factor is albedo.scale(catalog ? 0.85 : 0.9).
const EMISSIVE_SCALE = { catalog: .85, other: .9 } as const;
/** Legacy down pulse: emissive = downColor.scale(0.6 + 0.4 * sin(performance.now() / 180)). */
const downPulse = (nowMs: number): number => .6 + .4 * Math.sin(nowMs / 180);
const STATE_COLORS: Record<FabToolState, Triple> = {
  running: hexRgb(FAB_TOOL_STATE_META.running.color),
  idle: hexRgb(FAB_TOOL_STATE_META.idle.color),
  down: hexRgb(FAB_TOOL_STATE_META.down.color),
  maint: hexRgb(FAB_TOOL_STATE_META.maint.color),
};
function hexRgb(hex: string): Triple {
  const value = Number.parseInt(hex.slice(1), 16);
  return [value >> 16 & 255, value >> 8 & 255, value & 255].map(channel => channel / 255) as Triple;
}

interface BeaconBatch {
  readonly mesh: Mesh;
  readonly material: PbrMaterialProps;
  readonly colors: Float32Array;
  /** Emissive matrix needed by the frozen per-state lamp material. */
  readonly originalBaseColor: [number, number, number, number];
  readonly originalEmissive: readonly [number, number, number] | undefined;
  readonly originalPlugins: MaterialPlugin[] | undefined;
}
interface BeaconTarget {
  readonly batch: BeaconBatch;
  readonly instanceIndex: number;
  readonly emissiveScale: number;
}

/**
 * Per-tool status lamps on the equipment beacon thin instances.
 *
 * The frozen source swapped a per-(state, catalog) PBR material: albedo = state color,
 * emissive = state color * 0.9 (0.85 for catalog) and, for down tools, an animated
 * emissive pulse. Thin instances share one material, so the lantern identity is kept
 * by per-instance RGBA colors and a tiny public MaterialPlugin:
 * - RGB carries the state albedo (PBR multiplies it into baseColor),
 * - A carries the emissive scalar (0.85/0.9, or the down pulse); the plugin adds
 *   `emissive += instanceColor.rgb * instanceColor.a` before lighting composition,
 *   reproducing the source emissive exactly. Without enableMaterialPlugins(scene)
 *   the albedo stays correct, only the emissive tint is lost.
 */
export function createLiteToolStates(_scene: SceneContext, _engine: EngineContext, equipment: LiteEquipment): LiteToolStates {
  const targets: (BeaconTarget | undefined)[] = new Array(equipment.tools.length).fill(undefined);
  const batches = new Map<number, BeaconBatch>();
  for (const tool of equipment.tools) {
    const layout = FAB_LAYOUT[tool.layoutIndex];
    for (const part of tool.parts) {
      if (part.role !== 'beacon') continue;
      const batchMesh = equipment.batches[part.batchIndex]?.mesh;
      const material = batchMesh?.material as PbrMaterialProps | undefined;
      if (!batchMesh || !material || !('baseColorFactor' in material)) continue;
      let batch = batches.get(part.batchIndex);
      if (!batch) {
        const instances = batchMesh.thinInstances;
        if (!instances?.count) continue;
        batch = {
          mesh: batchMesh,
          material,
          colors: new Float32Array(instances.count * 4),
          originalBaseColor: [...(material.baseColorFactor ?? [1, 1, 1, 1])] as [number, number, number, number],
          originalEmissive: getPbrEmissiveColor(material),
          originalPlugins: material.plugins,
        };
        batches.set(part.batchIndex, batch);
      }
      targets[tool.layoutIndex] = {
        batch, instanceIndex: part.instanceIndex,
        emissiveScale: layout.originalKind === 'catalog' ? EMISSIVE_SCALE.catalog : EMISSIVE_SCALE.other,
      };
    }
  }

  const plugin: MaterialPlugin = {
    name: LAMP_PLUGIN,
    getCustomCode(shaderType) {
      if (shaderType !== 'fragment') return null;
      return {
        // Albedo: the source lamp material used the state color as base color. The PBR
        // thin-instance slot multiplies the shared white factor first; assign after it.
        CUSTOM_FRAGMENT_UPDATE_DIFFUSE: 'baseColor = input.vInstanceColor.rgb;',
        // Emissive: additive source term, before tone mapping. The alpha lane of the
        // per-instance color carries the (0.85|0.9|pulse) scalar.
        CUSTOM_FRAGMENT_BEFORE_LIGHTS: 'emissive = emissive + input.vInstanceColor.rgb * input.vInstanceColor.a;',
      };
    },
  };
  for (const batch of batches.values()) {
    // Per-instance colors must exist before the material group is built so the PBR
    // pipeline includes the thin-instance color attribute. Construction therefore has
    // to happen during compose, before registerScene.
    setThinInstanceColors(batch.mesh, batch.colors);
    batch.material.baseColorFactor = [1, 1, 1, 1];
    setPbrEmissive(batch.material, [0, 0, 0]);
    batch.material.plugins = [...(batch.material.plugins ?? []).filter(item => item.name !== LAMP_PLUGIN), plugin];
  }

  const states: FabToolState[] = [...FAB_TOOL_STATES];
  /** Dense list of tool indices currently `down`; update() pulses only these lamps. */
  const downIndices: number[] = [];
  let lastNowMs = 0;
  let disposed = false;

  function trackDown(index: number, previous: FabToolState, next: FabToolState): void {
    if (previous === next) return;
    if (next === 'down') { downIndices.push(index); return; }
    if (previous !== 'down') return;
    const at = downIndices.indexOf(index);
    if (at >= 0) downIndices.splice(at, 1);
  }

  function writeColor(index: number, state: FabToolState, pulseNow = lastNowMs): void {
    const target = targets[index];
    if (!target) return;
    const color = STATE_COLORS[state];
    const alpha = state === 'down' ? downPulse(pulseNow) : target.emissiveScale;
    target.batch.colors.set([color[0], color[1], color[2], alpha], target.instanceIndex * 4);
    setThinInstanceColor(target.batch.mesh, target.instanceIndex, color[0], color[1], color[2], alpha);
  }
  function rebuildBatch(batch: BeaconBatch, pulseNow: number): void {
    for (let index = 0; index < targets.length; index++) {
      const target = targets[index];
      if (!target || target.batch !== batch) continue;
      const color = STATE_COLORS[states[index]];
      const alpha = states[index] === 'down' ? downPulse(pulseNow) : target.emissiveScale;
      batch.colors.set([color[0], color[1], color[2], alpha], target.instanceIndex * 4);
    }
    setThinInstanceColors(batch.mesh, batch.colors);
  }
  function valid(index: number, state: FabToolState): boolean {
    return Number.isInteger(index) && index >= 0 && index < states.length
      && Object.prototype.hasOwnProperty.call(FAB_TOOL_STATE_META, state);
  }
  for (let index = 0; index < states.length; index++) {
    if (states[index] === 'down') downIndices.push(index);
    writeColor(index, states[index], 0);
  }

  return {
    setToolState(index, state) {
      if (disposed || !valid(index, state)) return;
      trackDown(index, states[index], state);
      states[index] = state;
      writeColor(index, state);
    },
    applyAll(next) {
      if (disposed) return;
      const count = Math.min(next.length, states.length);
      for (let index = 0; index < count; index++) {
        if (!valid(index, next[index])) continue;
        trackDown(index, states[index], next[index]);
        states[index] = next[index];
      }
      for (const batch of batches.values()) rebuildBatch(batch, lastNowMs);
    },
    update(_deltaMs, nowMs) {
      if (disposed || !Number.isFinite(nowMs)) return;
      // The source clock is absolute (performance.now), not accumulated deltas.
      lastNowMs = nowMs;
      // Fast path: no tool is down, so no emissive pulse can change this frame.
      if (downIndices.length === 0) return;
      const pulse = downPulse(nowMs);
      for (const index of downIndices) {
        const target = targets[index];
        if (!target) continue;
        const color = STATE_COLORS.down;
        target.batch.colors.set([color[0], color[1], color[2], pulse], target.instanceIndex * 4);
        setThinInstanceColor(target.batch.mesh, target.instanceIndex, color[0], color[1], color[2], pulse);
      }
    },
    prepareForDeviceRecovery() {
      if (disposed) return;
      for (const batch of batches.values()) {
        // Lite 1.36 rebuilds mesh geometry but keeps thin-instance GPU caches; reset the
        // public data slot so the native setters allocate fresh device state, then
        // reapply the current per-instance colors. Same public recovery pattern as
        // geometry/tool-families.ts.
        const instances = batch.mesh.thinInstances;
        if (instances) {
          batch.mesh.thinInstances = null;
          setThinInstances(batch.mesh, instances.matrices, instances.count);
        }
        setThinInstanceColors(batch.mesh, batch.colors);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const batch of batches.values()) {
        batch.material.plugins = batch.originalPlugins
          ? [...batch.originalPlugins]
          : (batch.material.plugins ?? []).filter(item => item.name !== LAMP_PLUGIN);
        batch.material.baseColorFactor = [...batch.originalBaseColor];
        if (batch.originalEmissive) {
          setPbrEmissive(batch.material, [batch.originalEmissive[0], batch.originalEmissive[1], batch.originalEmissive[2]]);
        }
      }
      batches.clear();
      downIndices.length = 0;
    },
  };
}
