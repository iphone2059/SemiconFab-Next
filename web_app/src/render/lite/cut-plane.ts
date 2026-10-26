/**
 * Native Lite section-cut plugins.
 *
 * The frozen Next backend clips the whole scene through `scene.clipPlane`
 * (babylon-webgpu.ts:560-574). Lite's public `setClipPlane` only feeds the scene
 * UBO; the native PBR/Standard templates do not discard against it, so the whole
 * FAB must opt in through public `MaterialPlugin` shader injections. This module
 * owns those two plugins and the shared render-space plane state:
 *
 *  - PBR plugin uniforms ride the host material UBO (read as `material.*`);
 *    changing the plane bumps those UBOs with `markMaterialUboDirty`.
 *  - Standard plugin uniforms use the bridge's self-managed `pluginUbo`
 *    (read as `pluginUbo.*`) with `dynamic: true`, which re-uploads every frame.
 *
 * The plane conversion is identical to the effects module
 * (web_app/src/render/lite/effects.ts:setCutPlane): the source plane is authored in
 * Next's RH domain and the render boundary reflects Z once, so only the Z normal
 * flips while the clamp stays -60..60. Both plugins discard the same half-space
 * with the same `dot(vec4(worldPos, 1), plane) > 0` rule as the frozen
 * clipPlane (and the hologram/trail shaders).
 *
 * Attach before `enableMaterialPlugins(scene)` runs: the Standard bridge bakes the
 * plugin signature while walking scene meshes, and PBR detects it while building
 * the renderable. Later attachment needs the caller's scene rebuild.
 */
import {
  bakeStdPluginMaterial, isPbrMaterial, isStandardMaterial, markMaterialUboDirty,
  type ClipPlane, type MaterialPlugin, type Mesh, type PbrMaterialProps, type SceneContext,
  type StandardMaterialProps,
} from '@babylonjs/lite';

export type LiteCutAxis = 'X' | 'Y' | 'Z';

export interface LiteCutPlane {
  /** Plugin for native PBR materials (uniforms ride the material UBO). */
  readonly pbr: MaterialPlugin;
  /** Plugin for native Standard materials (uniforms ride the self-managed plugin UBO). */
  readonly standard: MaterialPlugin;
  /** Same conversion/clamp as the effects module's setCutPlane (source domain -> render space). */
  setPlane(active: boolean, axis: LiteCutAxis, position: number, invert: boolean): void;
  /** Attach the family plugin to each mesh's material, idempotently. Call before scene build. */
  attach(meshes: readonly Pick<Mesh, 'material'>[], options?: { standard?: boolean }): void;
  /**
   * Lite 1.36 recovery boundary: the Standard bridge keeps its plugin UBO in a
   * device-owned buffer that native scene recovery does not rebuild. After a device
   * recovery the owning runtime must re-bake each attached Standard material so the
   * next frame binds a buffer created on the replacement device.
   */
  detachStandardForRecovery(scene: SceneContext): void;
  reattachStandardAfterRecovery(scene: SceneContext): void;
  /** Teardown: detach both plugins from every material this instance attached. */
  dispose(): void;
}

const PBR_PLUGIN_NAME = 'lite-cut-plane-pbr';
const STANDARD_PLUGIN_NAME = 'lite-cut-plane-standard';
const CUT_PLANE_MIN = -60;
const CUT_PLANE_MAX = 60;
const PLANE_FIELDS = [
  { name: 'cutPlane', type: 'vec4<f32>' },
  { name: 'cutPlaneActive', type: 'f32' },
] as const;

export function createLiteCutPlane(): LiteCutPlane {
  // Shared render-space state; both plugins read the same values.
  let planeActive = 0;
  let plane: ClipPlane = [0, 0, 0, 0];
  const pbrMaterials = new Set<PbrMaterialProps>();
  const standardMaterials = new Set<StandardMaterialProps>();
  const attachedMaterials = new Set<PbrMaterialProps | StandardMaterialProps>();
  let standardDetached = false;

  function writePlaneUbo(data: Float32Array, offsets: ReadonlyMap<string, number>): void {
    // Plugin offsets are byte offsets into the host UBO slice (float index = offset / 4).
    const planeOffset = (offsets.get('cutPlane') ?? 0) / 4;
    data[planeOffset] = plane[0];
    data[planeOffset + 1] = plane[1];
    data[planeOffset + 2] = plane[2];
    data[planeOffset + 3] = plane[3];
    data[(offsets.get('cutPlaneActive') ?? 16) / 4] = planeActive;
  }

  const pbrPlugin: MaterialPlugin = {
    name: PBR_PLUGIN_NAME,
    getUniforms: () => ({ ubo: PLANE_FIELDS.map(field => ({ ...field })) }),
    writeUbo: writePlaneUbo,
    // PBR fragment world position is the 'worldPos' varying (pbr-template.js).
    getCustomCode: shaderType => shaderType === 'fragment'
      ? {
        CUSTOM_FRAGMENT_MAIN_BEGIN:
          'if (material.cutPlaneActive >= 0.5 && dot(vec4<f32>(input.worldPos, 1.0), material.cutPlane) > 0.0) { discard; }',
      }
      : null,
  };

  const standardPlugin: MaterialPlugin = {
    name: STANDARD_PLUGIN_NAME,
    // Standard plugin values live in the bridge's self-managed plugin UBO and only
    // re-upload when the plugin is marked dynamic.
    dynamic: true,
    getUniforms: () => ({ ubo: PLANE_FIELDS.map(field => ({ ...field })) }),
    writeUbo: writePlaneUbo,
    // Standard fragment world position is the 'vp' varying (standard-template.js).
    getCustomCode: shaderType => shaderType === 'fragment'
      ? {
        CUSTOM_FRAGMENT_MAIN_BEGIN:
          'if (pluginUbo.cutPlaneActive >= 0.5 && dot(vec4<f32>(input.vp, 1.0), pluginUbo.cutPlane) > 0.0) { discard; }',
      }
      : null,
  };

  function attachPlugin(material: PbrMaterialProps | StandardMaterialProps,
    plugin: MaterialPlugin, name: string): void {
    const plugins = material.plugins ?? [];
    if (plugins.some(item => item === plugin)) return;
    material.plugins = [...plugins.filter(item => item.name !== name), plugin];
  }

  function attach(meshes: readonly Pick<Mesh, 'material'>[], attachOptions: { standard?: boolean } = {}): void {
    // Lite 1.36 Standard MaterialPlugin UBOs are device-owned and not recovered by the native
    // scene-recovery rebuild. Product integration therefore restricts the section cut to native
    // PBR materials (the whole FAB shell/equipment/facility/environment); Standard-material
    // dynamic actors keep their source look instead of risking a broken recovery.
    const attachStandard = attachOptions.standard !== false;
    for (const { material } of meshes) {
      if (isPbrMaterial(material)) {
        attachPlugin(material, pbrPlugin, PBR_PLUGIN_NAME);
        pbrMaterials.add(material);
        attachedMaterials.add(material);
      } else if (attachStandard && isStandardMaterial(material)) {
        attachPlugin(material, standardPlugin, STANDARD_PLUGIN_NAME);
        standardMaterials.add(material);
        attachedMaterials.add(material);
      }
    }
  }

  function setPlane(active: boolean, axis: LiteCutAxis, position: number, invert: boolean): void {
    const nextActive = active ? 1 : 0;
    let nextPlane: ClipPlane = [0, 0, 0, 0];
    if (active) {
      // Same literals as tests/lite-effects.test.ts:95-104: source clamp, then the
      // render-space Z reflection flips only the Z normal component.
      const flipped = invert ? -1 : 1;
      const clamped = Math.max(CUT_PLANE_MIN, Math.min(CUT_PLANE_MAX, position));
      nextPlane = axis === 'X'
        ? [flipped, 0, 0, -flipped * clamped]
        : axis === 'Y'
          ? [0, flipped, 0, -flipped * clamped]
          : [0, 0, -flipped, -flipped * clamped];
    }
    if (nextActive === planeActive && nextPlane.every((value, index) => value === plane[index])) return;
    planeActive = nextActive;
    plane = nextPlane;
    // PBR plugin values only follow the versioned material UBO; Standard re-uploads
    // through its dynamic plugin UBO path on its own.
    for (const material of pbrMaterials) markMaterialUboDirty(material);
  }

  function detachPlugin(material: PbrMaterialProps | StandardMaterialProps, plugin: MaterialPlugin): void {
    const plugins = material.plugins;
    if (!plugins?.length) return;
    const next = plugins.filter(item => item !== plugin);
    if (next.length !== plugins.length) material.plugins = next;
  }

  /** Device-loss boundary: clear Standard bridge state before native scene recovery rebuilds. */
  function detachStandardForRecovery(scene: SceneContext): void {
    if (standardDetached) return;
    standardDetached = true;
    for (const material of standardMaterials) {
      detachPlugin(material, standardPlugin);
      // Public bridge API: clears _pi/prepared plugins and releases the old-device UBO
      // so the recovery rebuild records no plugin binding for this material.
      bakeStdPluginMaterial(material, scene);
    }
  }

  /** Recovery boundary: reattach + bake on the replacement device before the first frame. */
  function reattachStandardAfterRecovery(scene: SceneContext): void {
    if (!standardDetached) return;
    standardDetached = false;
    for (const material of standardMaterials) {
      attachPlugin(material, standardPlugin, STANDARD_PLUGIN_NAME);
      bakeStdPluginMaterial(material, scene);
    }
  }

  function dispose(): void {
    if (attachedMaterials.size === 0) return;
    for (const material of attachedMaterials) {
      const plugins = material.plugins;
      if (!plugins?.length) continue;
      const next = plugins.filter(item => item !== pbrPlugin && item !== standardPlugin);
      if (next.length !== plugins.length) material.plugins = next;
    }
    for (const material of pbrMaterials) markMaterialUboDirty(material);
    pbrMaterials.clear();
    standardMaterials.clear();
    attachedMaterials.clear();
  }

  return { pbr: pbrPlugin, standard: standardPlugin, setPlane, attach, detachStandardForRecovery,
    reattachStandardAfterRecovery, dispose };
}
