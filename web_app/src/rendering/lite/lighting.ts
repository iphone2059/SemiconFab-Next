import {
  addToScene, createDirectionalLight, createHemisphericLight, createPointLight, createSpotLight,
  createTransformNode, setParent, setFog, markMaterialUboDirty, onBeforeRender, setLightIntensity, getPbrUnlit,
  type MaterialPlugin, type Mesh, type PbrMaterialProps, type PointLight, type SceneContext, type SpotLight,
} from '@babylonjs/lite';

type LocalLight = PointLight | SpotLight;
const capacity = 24;
const rgb = (hex: number): [number, number, number] => [hex >> 16 & 255, hex >> 8 & 255, hex & 255].map(v => v / 255) as [number, number, number];
const ambientColor = rgb(0xcfd8dc).map(v => v * 0.48);
const amberPoints = [
  [-27.5, -20, 2.6, 16], [-27.5, -10, 2.6, 16], [-27.5, 0, 2.4, 16],
  [-23.5, -15, 2.2, 14], [-23.5, 3.5, 1.8, 12],
] as const;

const packetSize = capacity * 16;

/**
 * Same 4-vec4 source layout as original-lighting.ts, evaluated in effective render space.
 * Writes the packet into a caller-owned buffer (packetSize floats) without allocating and
 * returns the active light count, so the per-frame path can reuse one packet across frames.
 */
export function packLiteLocalLightsInto(lights: readonly LocalLight[], data: Float32Array): number {
  let count = 0;
  for (const light of lights) {
    if (light.visible === false || light.intensity <= 0) continue;
    if (count === capacity) throw new Error('Source local-light capacity exceeded');
    const world = light.worldMatrix, offset = count++ * 16;
    const spot = light.lightType === 'spot' ? light as SpotLight : undefined;
    data[offset] = world[12]; data[offset + 1] = world[13]; data[offset + 2] = world[14];
    data[offset + 3] = light.range;
    data[offset + 4] = light.diffuse[0] * light.intensity;
    data[offset + 5] = light.diffuse[1] * light.intensity;
    data[offset + 6] = light.diffuse[2] * light.intensity;
    const direction = spot?.direction;
    const dx = direction ? world[0] * direction.x + world[4] * direction.y + world[8] * direction.z : 0;
    const dy = direction ? world[1] * direction.x + world[5] * direction.y + world[9] * direction.z : 0;
    const dz = direction ? world[2] * direction.x + world[6] * direction.y + world[10] * direction.z : 0;
    const length = Math.hypot(dx, dy, dz) || 1;
    data[offset + 8] = dx / length; data[offset + 9] = dy / length; data[offset + 10] = dz / length;
    data[offset + 11] = Number(light.metadata?.legacyDecay ?? (spot ? 2 : 1));
    if (spot) {
      data[offset + 12] = Math.cos(spot.angle / 2);
      data[offset + 13] = Math.cos(spot.angle * 0.55 / 2);
      data[offset + 14] = 1; data[offset + 15] = 0;
    } else {
      // Point lights keep the cone slot explicitly zeroed, so a reused packet never leaks a stale spot cone.
      data[offset + 12] = 0; data[offset + 13] = 0; data[offset + 14] = 0; data[offset + 15] = 0;
    }
  }
  return count;
}

/** Allocating wrapper kept for standalone callers; the lighting instance uses packLiteLocalLightsInto. */
export function packLiteLocalLights(lights: readonly LocalLight[]) {
  const data = new Float32Array(packetSize);
  const count = packLiteLocalLightsInto(lights, data);
  return { count, data };
}

/** Literal lighting inputs from legacy-site.ts:loadLegacyFab; no studio/environment lighting. */
export function createLiteLighting(scene: SceneContext, basementLights: readonly PointLight[]) {
  const root = createTransformNode('next-source-lights');
  const key = createDirectionalLight([-35, -65, -45], 1.15);
  key.name = 'native-key'; key.position.set(35, 65, 45); key.diffuse = rgb(0xfffbf5);
  const fill = createDirectionalLight([40, -35, 30], 0.32);
  fill.name = 'legacy-fill'; fill.diffuse = rgb(0x94a3b8);
  const ambient = createHemisphericLight([0, 1, 0], 0.48);
  ambient.name = 'legacy-ambient'; ambient.diffuseColor = rgb(0xcfd8dc); ambient.groundColor = rgb(0xcfd8dc);
  const localLights: LocalLight[] = amberPoints.map(([x, z, intensity, range], index) => {
    const light = createPointLight([x, 5.2, z], intensity);
    light.name = `original-litho-amber-${index}`; light.diffuse = rgb(0xf59e0b);
    light.range = range; light.metadata = { legacyDecay: 2 };
    return light;
  });
  const spot = createSpotLight([-27, 8.5, -9], [0, -1, 0], Math.PI * 4 / 9, 2, 3.2);
  spot.name = 'original-litho-spot'; spot.diffuse = rgb(0xf59e0b); spot.range = 24;
  spot.metadata = { legacyDecay: 2 };
  localLights.push(spot);
  for (const light of [key, fill, ambient, ...localLights]) { setParent(light, root); addToScene(scene, light); }
  localLights.push(...basementLights);
  const baseIntensities = new Map(localLights.map(light => [light, light.intensity] as const));
  Object.assign(scene.imageProcessing, { exposure: 1, contrast: 1, toneMappingEnabled: false });
  setFog(scene, { mode: 2, density: 0.0055, start: 0, end: 1000, color: [0.945, 0.961, 0.976] });

  let localsEnabled = true, ambientEnabled = true, disposed = false;
  let cached: { count: number; data: Float32Array } | null = null;
  let previousCount = -1, previousHash = 0;
  const materials = new Set<PbrMaterialProps>();
  function dirty() { for (const material of materials) markMaterialUboDirty(material); }
  // One packet owned by this lighting instance: onBeforeRender and every material's UBO
  // write share it instead of allocating a fresh 384-float array per frame.
  const packet = new Float32Array(packetSize);
  function repack() {
    cached = { count: packLiteLocalLightsInto(localLights, packet), data: packet };
    return cached;
  }
  const plugin: MaterialPlugin = {
    name: 'next-source-linear-lighting',
    getUniforms: () => ({ ubo: [
      { name: 'fabAmbient', type: 'vec4<f32>' }, { name: 'fabLightInfo', type: 'vec4<f32>' },
      // Public Lite UBO arrays support vec4<u32>. Float bit patterns are decoded in WGSL.
      { name: 'fabLocalLights', type: 'array<vec4<u32>, 96>' },
    ] }),
    writeUbo(data, offsets) {
      const packed = cached ?? repack();
      data.set([...ambientColor.map(value => value * (ambientEnabled ? 1 : 0)), 0], offsets.get('fabAmbient')! / 4);
      data.set([localsEnabled ? packed.count : 0, 0, 0, 0], offsets.get('fabLightInfo')! / 4);
      data.set(packed.data, offsets.get('fabLocalLights')! / 4);
    },
    getCustomCode: stage => stage === 'fragment' ? {
      CUSTOM_FRAGMENT_MAIN_BEGIN: 'var fabLinearColor=vec3<f32>(0.0);',
      // The source r128 Lambert diffuse has no dielectric-F0 subtraction.
      CUSTOM_FRAGMENT_BEFORE_LIGHTS: 'surfaceAlbedo=baseColor*(1.0-metallic);',
      CUSTOM_FRAGMENT_BEFORE_FINALCOLORCOMPOSITION: `{
        var fabLocalDiffuse=vec3<f32>(0.0);var fabLocalSpecular=vec3<f32>(0.0);
        for(var i=0u;i<u32(material.fabLightInfo.x);i++){
          let pr=bitcast<vec4<f32>>(material.fabLocalLights[i*4u]);
          let lc=bitcast<vec4<f32>>(material.fabLocalLights[i*4u+1u]).rgb;
          let dd=bitcast<vec4<f32>>(material.fabLocalLights[i*4u+2u]);
          let cone=bitcast<vec4<f32>>(material.fabLocalLights[i*4u+3u]);
          let offset=pr.xyz-input.worldPos;let distance=length(offset);let localL=offset/max(distance,0.0001);
          var attenuation=pow(max(0.0,1.0-distance/pr.w),dd.w);
          if(cone.z>0.5){attenuation*=smoothstep(cone.x,cone.y,dot(-dd.xyz,localL));}
          let nl=max(dot(N,localL),0.0);
          fabLocalDiffuse+=surfaceAlbedo*(1.0/PI)*nl*lc*attenuation*material.directIntensity;
          if(nl>0.0&&attenuation>0.0){
            let halfVector=normalize(V+localL);let nh=clamp(dot(N,halfVector),0.0000001,1.0);
            let vh=saturate(dot(V,halfVector));let r=max(roughness,AA_factor_x);let a=r*r+0.0005;
            fabLocalSpecular+=fresnelSchlick(vh,colorF0,colorF90)*distributionGGX(nh,a)
              *geometrySmithGGX(nl,NdotV,a)*nl*lc*attenuation*material.directIntensity;
          }
        }
        fabLinearColor=color+surfaceAlbedo*material.fabAmbient.rgb+fabLocalDiffuse+fabLocalSpecular;
      }`,
      // The frozen source renders with THREE LinearEncoding and no tone mapping: the displayed
      // bytes are the linear light values, with its own unpowered fog factor. Lite's PBR template
      // gamma-encodes, and scenes with transmissive materials (all source curtain glass) retarget
      // the pass to rgba16float and append an image-processing task that gamma-encodes once more.
      // Write the source linear value, pre-compensating only that trailing encode.
      CUSTOM_FRAGMENT_BEFORE_FRAGCOLOR: `{
        let sourceFog=calcFogFactor((scene.view*vec4<f32>(input.worldPos,1.0)).xyz);
        let sourceColor=clamp(mix(scene.vFogColor.rgb,fabLinearColor,sourceFog),vec3<f32>(0.0),vec3<f32>(1.0));
        color=select(sourceColor,pow(sourceColor,vec3<f32>(2.2)),scene.vImageInfos.w<0.0);
      }`,
    } : null,
  };
  // Pack once per frame (facility lamps animate), detect changes with an allocation-free hash,
  // and let the material UBO writer reuse the same packet instead of repacking per material.
  onBeforeRender(scene, () => {
    if (disposed) return;
    const packed = repack();
    let hash = 0;
    for (let i = 0; i < packed.count * 16; i += 1) hash = (hash * 31 + Math.round(packed.data[i] * 10000)) | 0;
    if (packed.count !== previousCount || hash !== previousHash) {
      previousCount = packed.count; previousHash = hash; dirty();
    }
  });
  return {
    root, key, fill, ambient, localLights,
    configureMaterials(meshes: readonly Pick<Mesh, 'id' | 'material'>[]) {
      const pbrIds = new Set<string>();
      for (const [index, mesh] of meshes.entries()) {
        if (!mesh.material || !('baseColorFactor' in mesh.material)) continue;
        const material = mesh.material as PbrMaterialProps;
        // Let Lite's native unlit fragment own these materials, including its final colour.
        if (getPbrUnlit(material)) continue;
        material.plugins = [...(material.plugins ?? []).filter(item => item.name !== plugin.name), plugin];
        mesh.id ??= `next-pbr-lighting-${index}`;
        materials.add(material); pbrIds.add(mesh.id);
      }
      // PBR ambient/locals use the source plugin; Standard uses the native lights.
      for (const light of [ambient, ...localLights]) light.excludedMeshIds = pbrIds;
    },
    setLocalLightsEnabled(enabled: boolean) {
      localsEnabled = enabled; cached = null;
      for (const light of localLights) {
        light.visible = enabled;
        setLightIntensity(light, enabled ? baseIntensities.get(light) ?? 0 : 0);
      }
      dirty();
    },
    setAmbientEnabled(enabled: boolean) {
      ambientEnabled = enabled; cached = null;
      setLightIntensity(ambient, enabled ? 0.48 : 0); dirty();
    },
    setFillEnabled(enabled: boolean) { setLightIntensity(fill, enabled ? 0.32 : 0); },
    // onBeforeRender is scene-owned; scene disposal releases its callback.
    dispose() { disposed = true; materials.clear(); },
  };
}
