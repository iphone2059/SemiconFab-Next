import { createCsmDirectionalShadowGenerator, enableCsmStaticCache, setShadowTaskCasterMeshes,
  setShadowGeneratorEnabled, type DirectionalLight, type EngineContext, type Mesh, type PbrMaterialProps,
  type SceneContext } from '@babylonjs/lite';

/** Matches legacy-site.ts's source caster exclusions; visibility remains native and dynamic.
 *  Frozen metadata solves the static decision; unknown entries repeat the source runtime
 *  material test and line meshes are excluded by their LineMaterial. */
export function selectLiteShadowCasters(meshes: readonly Mesh[]) {
  return meshes.filter(mesh => {
    const material = mesh.material as (Partial<PbrMaterialProps> & { useVertexAlpha?: boolean }) | null | undefined;
    if (material && ('useVertexAlpha' in material || (material.alpha ?? 1) < 1 || material.alphaBlend === true)) return false;
    if (mesh.name === 'procedural-floor' || mesh.name === 'procedural-slab') return false;
    return mesh.metadata?.staticShadowCaster !== false;
  });
}

/** Recoverable native depth32float + PCF comparison sampling, owned and rebuilt by Lite. */
export async function createLiteShadows(scene: SceneContext, engine: EngineContext, key: DirectionalLight) {
  const casters = selectLiteShadowCasters(scene.meshes);
  const generator = createCsmDirectionalShadowGenerator(engine, key, {
    mapSize: 2048, numCascades: 2, shadowMaxZ: 180, stabilizeCascades: true,
    lambda: 0.5, cascadeBlendPercentage: 0.1, bias: 0.00015, darkness: 0,
  });
  // Transfer ownership immediately so composition failures also dispose GPU resources.
  key.shadowGenerator = generator;
  // addToScene in Lite 1.36 does not append shadow generators; this public list also owns recovery.
  scene.shadowGenerators.push(generator);
  setShadowTaskCasterMeshes(generator, casters);
  await enableCsmStaticCache(engine, generator, { refitAngle: 0.0001 });
  let enabled = true, current = casters;
  return {
    generator, casters: current,
    get enabled() { return enabled; },
    setEnabled(value: boolean) { enabled = value; setShadowGeneratorEnabled(generator, value); },
    /** Source invalidates the static depth after layer/level visibility changes. A native membership
     * change forces the next refit, so hiding a layer cannot leave its cached shadow behind. */
    setCasters(meshes: readonly Mesh[]) {
      if (meshes.length === current.length && meshes.every((mesh, index) => mesh === current[index])) return;
      current = [...meshes];
      setShadowTaskCasterMeshes(generator, current);
    },
    get activeCasters(): readonly Mesh[] { return current; },
  };
}
