/**
 * X-Ray hologram effect owner (native Lite).
 *
 * Owns the one frozen WGSL program's palette materials (per surface state and the catalog
 * line variant), the X-Ray caster override, the borrowed CSM receiver bindings and the
 * X-Ray target material restore/apply transaction. The WGSL sources, uniform/sampler
 * contract and frozen palette values live in ./xray-shaders.ts; the pure source-state
 * matrix lives in ../effects-xray-state.ts and this module only turns those values into
 * native materials.
 *
 * Parity sources: web_app/src/xray-hologram.ts:60-201 (program and palette) and
 * web_app/src/legacy-site.ts:449-524 (per-role target application/restoration).
 * Shadows are borrowed from the native CSM receiver texture instead of the frozen custom
 * depth pass: the generator keeps ownership, this effect only binds and mirrors the
 * receiver UBO. It never releases the borrowed texture.
 */
import {
  createShaderMaterial, createStandardMaterial, enableShaderMaterialInstanceWorld,
  getCsmReceiverTexture, getShaderTexture, onCsmReceiverUpdate, setShaderTexture,
  setShaderUniform, setShadowCasterMaterial,
  type ClipPlane, type Material, type Mesh, type ShadowGenerator, type ShaderMaterial,
  type Texture2D,
} from '@babylonjs/lite';
import {
  liteXraySystemMatches, liteXraySurfaceState,
  type LiteXrayFilter, type LiteXraySurfaceRole, type LiteXraySurfaceState,
} from '@/rendering/lite-effects-xray-state';
import {
  LITE_XRAY_SHADER_PROGRAM, XRAY_GLOW, XRAY_LINE_PARAMS, XRAY_NORMAL_LINE_COLOR,
  XRAY_TINT, XRAY_ZERO_PARAMS, type LiteXrayShaderProgram,
} from '@/rendering/lite-effects-xray-shaders';

export interface LiteXrayTarget {
  readonly mesh: Mesh;
  readonly role: LiteXraySurfaceRole;
}

/** Configured X-Ray target counts per source role (acceptance diagnostics). */
export interface LiteXrayTargetCounts {
  readonly equipment: number;
  readonly floor: number;
  readonly subfab: number;
  readonly oht: number;
}

export interface LiteXrayOptions {
  /** Product composition: borrow the live CSM receiver (2-layer depth32float + comparison sampler)
   * so the hologram is modulated by the same shadow map as native PBR. Palette materials cast
   * through a depth-only Standard material, which keeps the CSM caster pass free of the receiver
   * sampler (Lite 1.36 otherwise reports a writable+sampled usage conflict inside refit frames).
   * Standalone unit fixtures omit it and never render the palette. */
  readonly shadows?: ShadowGenerator;
  /** Frozen WGSL/uniform/sampler contract. Product assembly uses the frozen source port; an
   * override exists so a malformed contract can be proven to fail loudly at material creation
   * instead of rendering a silently broken palette. */
  readonly program?: LiteXrayShaderProgram;
}

export interface LiteXrayEffect {
  /** Advance the hologram clock and re-sync a replaced CSM receiver texture. */
  update(nowMs: number): void;
  /** Replace the X-Ray surface set; an active filter is immediately re-applied to it. */
  configureTargets(targets: readonly LiteXrayTarget[]): void;
  /** Frozen babylon-webgpu.ts behaviour: null restores every target's original material. */
  setFilter(filter: LiteXrayFilter | null): void;
  /** Copy the section-cut plane into every palette shader (same half-space discard). */
  setCutPlane(plane: ClipPlane): void;
  /** Borrow a CSM receiver; detaches the previously borrowed generator first. */
  bindShadows(generator: ShadowGenerator): void;
  /** True once the CSM depth texture is actually bound (after the transition warm-up). */
  readonly shadowLinked: boolean;
  readonly targetCounts: LiteXrayTargetCounts;
  dispose(): void;
}

interface SavedXrayTarget {
  readonly material: Material;
  readonly xrayCaster: boolean | undefined;
}

interface CsmShadowViews {
  cascade0: Float32Array; cascade1: Float32Array; cascade2: Float32Array; cascade3: Float32Array;
  viewFrustumZ: Float32Array; frustumLengths: Float32Array; shadowsInfo: Float32Array; csmParams: Float32Array;
}

export function createXrayEffect(options: LiteXrayOptions = {}): LiteXrayEffect {
  const program = options.program ?? LITE_XRAY_SHADER_PROGRAM;

  // ---- X-Ray palette (xray-hologram.ts:119-201). ----
  const paletteMaterials: ShaderMaterial[] = [];
  const meshMaterials = new Map<string, ShaderMaterial>();
  let xrayClock = 0;
  // Declared before bindShadows(): the CSM receiver callback may run synchronously during
  // bindShadows and uses this to decide whether the palette fan-out is observable.
  let activeFilter: LiteXrayFilter | null = null;
  let cutPlaneState: ClipPlane = [0, 0, 0, 0];

  // ---- Shadow borrowing: the generator keeps ownership, the palette only binds. ----
  let shadowGenerator: ShadowGenerator | undefined;
  let shadowTexture: Texture2D | null = null;
  let shadowData: Float32Array | null = null;
  // B04: the receiver UBO is 80 floats. Reuse one buffer and its eight subarray views
  // instead of allocating a fresh typed array per callback and eight views per material.
  let shadowViews: CsmShadowViews | null = null;
  let detachCsmReceiver: (() => void) | undefined;
  let disposed = false;

  function applyShadowBinding(material: ShaderMaterial): void {
    if (shadowTexture && getShaderTexture(material, 'xrayDepth') !== shadowTexture) {
      setShaderTexture(material, 'xrayDepth', shadowTexture);
    }
    setShaderUniform(material, 'xrayShadowEnabled', shadowTexture && shadowData ? 1 : 0);
    if (shadowData) writeCsmUniforms(material);
  }

  function receiveShadowData(data: Float32Array): void {
    if (!shadowData || !shadowViews || shadowData.length !== data.length) {
      shadowData = new Float32Array(data.length);
      shadowViews = {
        cascade0: shadowData.subarray(0, 16),
        cascade1: shadowData.subarray(16, 32),
        cascade2: shadowData.subarray(32, 48),
        cascade3: shadowData.subarray(48, 64),
        viewFrustumZ: shadowData.subarray(64, 68),
        frustumLengths: shadowData.subarray(68, 72),
        shadowsInfo: shadowData.subarray(72, 76),
        csmParams: shadowData.subarray(76, 80),
      };
    }
    shadowData.set(data);
  }

  function writeCsmUniforms(material: ShaderMaterial): void {
    if (!shadowViews) return;
    setShaderUniform(material, 'xrayCascade0', shadowViews.cascade0);
    setShaderUniform(material, 'xrayCascade1', shadowViews.cascade1);
    setShaderUniform(material, 'xrayCascade2', shadowViews.cascade2);
    setShaderUniform(material, 'xrayCascade3', shadowViews.cascade3);
    setShaderUniform(material, 'xrayViewFrustumZ', shadowViews.viewFrustumZ);
    setShaderUniform(material, 'xrayFrustumLengths', shadowViews.frustumLengths);
    setShaderUniform(material, 'xrayShadowsInfo', shadowViews.shadowsInfo);
    setShaderUniform(material, 'xrayCsmParams', shadowViews.csmParams);
  }

  function syncMaterialFrame(material: ShaderMaterial): void {
    setShaderUniform(material, 'cutPlane', cutPlaneState);
    setShaderUniform(material, 'xrayTime', xrayClock);
    applyShadowBinding(material);
  }

  function createHologramMaterial(name: string, line: boolean, state?: LiteXraySurfaceState): ShaderMaterial {
    const material = createShaderMaterial({
      name,
      vertexSource: program.vertexSource,
      fragmentSource: program.fragmentSource,
      attributes: [...program.attributes],
      uniforms: [...program.uniforms],
      samplers: [...program.samplers],
      needAlphaBlending: true,
      blendMode: 'alpha',
      backFaceCulling: false,
      // xray-hologram.ts:147: highlighted utility surfaces write depth, ghosts do not.
      depthWrite: line ? false : (state?.highlight ?? 0) >= 0.5,
      ...(line ? { topology: 'line-list' as const } : {}),
    });
    enableShaderMaterialInstanceWorld(material);
    paletteMaterials.push(material);
    // CSM casters use a depth-only Standard view so the shadow pass never binds the palette's
    // receiver sampler while writing the same depth texture (Lite 1.36 usage-scope conflict).
    if (casterMaterial) setShadowCasterMaterial(material, casterMaterial);
    setShaderUniform(material, 'xrayTint', XRAY_TINT);
    setShaderUniform(material, 'xrayGlow', XRAY_GLOW);
    if (line) {
      setShaderUniform(material, 'xrayOptions', [1, 0, 0, 0]);
      setShaderUniform(material, 'xrayNormalColor', XRAY_NORMAL_LINE_COLOR);
      setShaderUniform(material, 'xrayParams', XRAY_ZERO_PARAMS);
    } else {
      setShaderUniform(material, 'xrayOptions', [0, 0, 0, 0]);
      setShaderUniform(material, 'xrayNormalColor', [0, 0, 0, 0]);
      setShaderUniform(material, 'xrayParams', [1, state!.ghostAlpha, state!.highlight, state!.rimPower]);
    }
    syncMaterialFrame(material);
    return material;
  }

  const casterMaterial: Material | null = options.shadows
    ? (() => {
      const material = createStandardMaterial();
      material.name = 'fab-xray-shadow-caster';
      material.diffuseColor = [0.5, 0.5, 0.5];
      material.alpha = 1;
      return material;
    })()
    : null;
  const lineMaterial = createHologramMaterial('fab-xray-line', true);
  // Product composition: bind the live CSM receiver before the first rendered frame.
  if (options.shadows) bindShadows(options.shadows);

  function meshMaterial(state: LiteXraySurfaceState): ShaderMaterial {
    // xray-hologram.ts:136-151: one material instance per ghost/highlight state.
    const key = state.highlight + ':' + state.ghostAlpha + ':' + state.rimPower;
    let material = meshMaterials.get(key);
    if (!material) {
      material = createHologramMaterial('fab-xray-' + meshMaterials.size, false, state);
      meshMaterials.set(key, material);
    }
    return material;
  }

  function setLineXray(enabled: boolean): void {
    setShaderUniform(lineMaterial, 'xrayParams', enabled ? XRAY_LINE_PARAMS : XRAY_ZERO_PARAMS);
  }

  function syncShadowTexture(): void {
    if (!shadowGenerator) return;
    const next = getCsmReceiverTexture(shadowGenerator);
    if (next === shadowTexture) return;
    shadowTexture = next;
    for (const material of paletteMaterials) applyShadowBinding(material);
  }

  function bindShadows(generator: ShadowGenerator): void {
    if (disposed) return;
    detachCsmReceiver?.();
    shadowGenerator = generator;
    shadowData = null;
    shadowTexture = getCsmReceiverTexture(generator);
    // The generator publishes its 80-float receiver UBO (four cascade matrices + slices)
    // right before the shadow map renders; custom ShaderMaterial receivers MUST mirror it
    // from inside this callback rather than an onBeforeRender hook.
    detachCsmReceiver = onCsmReceiverUpdate(generator, data => {
      if (disposed) return;
      receiveShadowData(data);
      // B04: while X-Ray is active the palette materials are attached to rendered meshes and
      // must mirror the receiver UBO. While it is inactive no mesh uses them, so the
      // per-material uniform fan-out is skipped; enabling resyncs from the retained snapshot.
      if (activeFilter === null) return;
      for (const material of paletteMaterials) {
        setShaderUniform(material, 'xrayShadowEnabled', shadowTexture ? 1 : 0);
        writeCsmUniforms(material);
      }
    });
    for (const material of paletteMaterials) applyShadowBinding(material);
  }

  // ---- X-Ray target application/restoration (legacy-site.ts:469-524). ----
  const savedTargets = new Map<Mesh, SavedXrayTarget>();
  let xrayTargets: readonly LiteXrayTarget[] = [];

  function readXrayCaster(mesh: Mesh): boolean | undefined {
    const metadata = mesh.metadata as { xrayCaster?: boolean } | null | undefined;
    return metadata?.xrayCaster;
  }

  function restoreXray(): void {
    for (const [mesh, saved] of savedTargets) {
      mesh.material = saved.material;
      const metadata = (mesh.metadata ?? {}) as Record<string, unknown>;
      if (saved.xrayCaster === undefined) delete metadata.xrayCaster;
      else metadata.xrayCaster = saved.xrayCaster;
      mesh.metadata = metadata;
    }
    savedTargets.clear();
    setLineXray(false);
  }

  function applyXray(filter: LiteXrayFilter | null): void {
    restoreXray();
    activeFilter = filter;
    if (!filter) return;
    for (const target of xrayTargets) {
      const mesh = target.mesh;
      if (!mesh || savedTargets.has(mesh)) continue;
      // legacy-site.ts:468 excludes the AMHS contact-shadow decals from the X-Ray surface set.
      if (target.role === 'oht' && mesh.name.includes('-shadow')) continue;
      savedTargets.set(mesh, { material: mesh.material, xrayCaster: readXrayCaster(mesh) });
      // Catalog wire meshes keep the frozen '-wire' identity and use the same program with
      // line-list topology (xray-hologram.ts:198, legacy-site.ts:463-464).
      const line = mesh.name.endsWith('-wire');
      const activeRole = target.role !== 'subfab'
        || filter === 'all' || liteXraySystemMatches(mesh.name, filter);
      mesh.material = line ? lineMaterial : meshMaterial(liteXraySurfaceState(target.role, filter, activeRole));
      mesh.metadata = { ...mesh.metadata, xrayCaster: true };
    }
    // B04: the CSM fan-out pauses while X-Ray is off; re-apply the retained receiver
    // snapshot before the first active frame so the visuals are unchanged.
    for (const material of paletteMaterials) applyShadowBinding(material);
    setLineXray(true);
    updateXrayFrame();
  }

  function updateXrayFrame(): void {
    for (const material of paletteMaterials) setShaderUniform(material, 'xrayTime', xrayClock);
    syncShadowTexture();
  }

  function update(nowMs: number): void {
    if (disposed) return;
    if (Number.isFinite(nowMs)) xrayClock = nowMs / 1000;
    if (activeFilter !== null) {
      for (const material of paletteMaterials) setShaderUniform(material, 'xrayTime', xrayClock);
    }
    syncShadowTexture();
  }

  function configureTargets(targets: readonly LiteXrayTarget[]): void {
    if (disposed) return;
    restoreXray();
    xrayTargets = targets.slice();
    if (activeFilter !== null) applyXray(activeFilter);
  }

  function setFilter(filter: LiteXrayFilter | null): void {
    if (disposed) return;
    applyXray(filter);
  }

  function setCutPlane(plane: ClipPlane): void {
    if (disposed) return;
    cutPlaneState = [plane[0], plane[1], plane[2], plane[3]];
    for (const material of paletteMaterials) setShaderUniform(material, 'cutPlane', cutPlaneState);
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    // Restore every saved target material/metadata before dropping the palette resources.
    restoreXray();
    detachCsmReceiver?.();
    detachCsmReceiver = undefined;
    shadowGenerator = undefined;
    shadowTexture = null;
    shadowData = null;
    shadowViews = null;
    savedTargets.clear();
    meshMaterials.clear();
    paletteMaterials.length = 0;
  }

  return {
    update,
    configureTargets,
    setFilter,
    setCutPlane,
    bindShadows,
    get shadowLinked() { return !!shadowTexture && !!shadowData; },
    get targetCounts() {
      const counts = { equipment: 0, floor: 0, subfab: 0, oht: 0 };
      for (const target of xrayTargets) counts[target.role] += 1;
      return counts;
    },
    dispose,
  };
}
