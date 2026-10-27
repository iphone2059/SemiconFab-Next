import {
  addToScene, createLineMaterial, createLineSystem, createMeshFromData, createPbrMaterial,
  createPointLight, createStandardMaterial, createTransformNode, createDynamicTexture,
  setParent, setPbrEmissive, setPbrTransmission, setSubtreeVisible, setTextureTransform,
  setThinInstances, setThinInstanceColors, updateDynamicTexture, releaseTexture,
  enableMaterialUvTransform, loadHdrEnvironment, decomposeMat4, rebuildMaterial, markMaterialUboDirty, enableThinInstanceWorldBounds,
  type DynamicTexture2D, type EngineContext, type Mat4, type Material, type Mesh, type PbrMaterialProps, type PointLight, type SceneContext, type TransformNode,
} from '@babylonjs/lite';
import { staticStructure as source, type PackedSourceEntity } from './static-structure-packed';
import { originalFloorOpacity } from '../../../twin-spatial';

export type StaticLayer = 'shell' | 'ffu' | 'b1';
export interface StaticSurfaceDefinition {
  kind: 'pbr' | 'standard' | 'line'; color: number[]; alpha: number;
  metallic?: number; roughness?: number; emissive?: number[]; specular?: number[]; power?: number;
  doubleSided?: boolean; depthWrite?: boolean; zOffset?: number;
  refraction?: { intensity: number; ior: number } | null;
  texture?: { width: number; height: number; uScale: number; vScale: number; gammaSpace: boolean;
    operations: unknown[][] };
}

/** Lite transmission depends on an IBL fragment, even when scene radiance is zero.
 * Load an all-black 4x2 RGBE through the public HDR loader; material environment
 * intensities remain zero, so no environmental illumination is added. */
export async function prepareStaticStructureEnvironment(scene: SceneContext): Promise<void> {
  const header = new TextEncoder().encode('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 2 +X 4\n');
  const bytes = new Uint8Array(header.length + 4 * 2 * 4);
  bytes.set(header);
  const url = 'data:application/octet-stream;base64,' + btoa(String.fromCharCode(...bytes));
  const imageProcessing = { ...scene.imageProcessing };
  await loadHdrEnvironment(scene, url, { faceSize: 16, skipSkybox: true, skipGround: true });
  Object.assign(scene.imageProcessing, imageProcessing);
}
export interface StaticPart {
  readonly name: string;
  readonly layer: StaticLayer;
  readonly mesh: Mesh;
  readonly instanceIndex: number;
}
export interface LiteStaticStructure {
  readonly parts: StaticPart[];
  readonly batches: Mesh[];
  readonly roots: Record<StaticLayer, TransformNode>;
  readonly lightRoot: TransformNode;
  readonly lights: PointLight[];
  setVisible(layer: StaticLayer, visible: boolean): void;
  setOffset(layer: StaticLayer, y: number): void;
  setLevel(level: 'L1' | 'B1' | 'DUAL' | 'EXPLODED'): Promise<void>;
  prepareForDeviceRecovery(): void;
  dispose(): void;
}
/** Frozen source vertex data, composed directly into native Lite resources. No legacy engine is loaded. */
export function createLiteStaticStructure(scene: SceneContext, engine: EngineContext): LiteStaticStructure {
  const roots = { shell: createTransformNode('static-shell'), ffu: createTransformNode('static-ffu'),
    b1: createTransformNode('static-b1') };
  const lightRoot = createTransformNode('static-b1-lights');
  // Source-disabled frozen meshes hang outside the layer roots so setVisible/setLevel cannot
  // re-show them by cascading visibility through the shell subtree.
  const sourceDisabledRoot = createTransformNode('static-source-disabled');
  setSubtreeVisible(sourceDisabledRoot, false);
  const parts: StaticPart[] = [], batches: Mesh[] = [];
  const materials = new Map<string, Material>();
  const ownedTextures = new Set<DynamicTexture2D>();
  // The generated module already stores typed vertex buffers; resolve them once per frozen
  // geometry id. 396 batches share 222 geometries, so repeated batches reuse the same immutable
  // buffers instead of converting/copying source arrays once per batch.
  const sharedGeometries = new Map<string, { positions: Float32Array; normals: Float32Array;
    indices: Uint32Array; uvs?: Float32Array }>();
  function sharedGeometryFor(id: string) {
    const cached = sharedGeometries.get(id);
    if (cached) return cached;
    const geometry = source.geometries[id];
    const shared = { positions: geometry.positions, normals: geometry.normals,
      indices: geometry.indices, uvs: geometry.uvs.length > 0 ? geometry.uvs : undefined };
    sharedGeometries.set(id, shared);
    return shared;
  }
  function dispose() {
    // Release creator claims; registered material bindings retain their own claims
    // until the scene is disposed. This also covers failed pre-registration uploads.
    for (const texture of ownedTextures) releaseTexture(texture);
    ownedTextures.clear();
  }
  function materialFor(id: string) {
    let material = materials.get(id);
    if (material) return material;
    const definition = source.materials[id];
    const rgb = definition.color as [number, number, number];
    if (definition.kind === 'pbr') {
      const pbr = createPbrMaterial({ baseColorFactor: [...rgb, definition.alpha],
        metallicFactor: definition.metallic, roughnessFactor: definition.roughness,
        doubleSided: definition.doubleSided, alphaBlend: definition.alpha < 1,
        directIntensity: Math.PI, environmentIntensity: 0, usePhysicalLightFalloff: false });
      setPbrEmissive(pbr, definition.emissive as [number, number, number]);
      if (definition.refraction) setPbrTransmission(pbr, {
        intensity: definition.refraction.intensity, indexOfRefraction: definition.refraction.ior,
      });
      if (definition.texture) {
        const recipe = definition.texture;
        const canvas = document.createElement('canvas');
        canvas.width = recipe.width; canvas.height = recipe.height;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Static floor Canvas2D is unavailable');
        // Replay the frozen source's Canvas2D recipe, including its linear texture encoding.
        const target = context as unknown as Record<string, unknown>;
        for (const [operation, key, ...args] of recipe.operations) {
          if (operation === 'set') target[key as string] = args[0];
          else Reflect.apply(target[key as string] as (...values: unknown[]) => void, context, args);
        }
        const texture = createDynamicTexture(engine, recipe.width, recipe.height,
          { srgb: recipe.gammaSpace, mipMaps: true, addressModeU: 'repeat', addressModeV: 'repeat' });
        ownedTextures.add(texture);
        pbr.baseColorTexture = texture;
        setTextureTransform(texture, { uScale: recipe.uScale, vScale: recipe.vScale, uOffset: 0, vOffset: 0, uAng: 0 });
        enableMaterialUvTransform(pbr);
        updateDynamicTexture(engine, texture, canvas, { invertY: false });
      }
      material = pbr;
    } else if (definition.kind === 'standard') {
      const standard = createStandardMaterial();
      standard.diffuseColor = rgb; standard.alpha = definition.alpha;
      standard.emissiveColor = definition.emissive as [number, number, number];
      standard.specularColor = definition.specular as [number, number, number];
      standard.specularPower = definition.power!; standard.backFaceCulling = !definition.doubleSided;
      material = standard;
    } else material = createLineMaterial({ color: { r: rgb[0], g: rgb[1], b: rgb[2], a: definition.alpha },
      useThinInstances: definition.alpha >= 1 });
    material.name = `static-material-${id}`;
    materials.set(id, material);
    return material;
  }

  try {
    const groups = new Map<string, PackedSourceEntity[]>();
    for (const entity of source.entities) {
      // Keep independent transparent meshes for native sorting. Only opaque peers share a batch.
      const key = JSON.stringify([entity.layer, entity.geometry, entity.material, entity.caster,
        entity.receiveShadows, source.materials[entity.material].alpha < 1 ? entity.name : null]);
      const group = groups.get(key);
      if (group) group.push(entity); else groups.set(key, [entity]);
    }
    for (const entities of groups.values()) {
      const first = entities[0], geometry = source.geometries[first.geometry];
      const material = materialFor(first.material);
      let mesh: Mesh;
      if (geometry.lines) {
        const lines: { x: number; y: number; z: number }[][] = [];
        for (let start = 0; start < geometry.indices.length; start += 2) {
          const line = [];
          for (let point = start; point < Math.min(start + 2, geometry.indices.length); point += 1) {
            const index = geometry.indices[point];
            line.push({ x: geometry.positions[index * 3], y: geometry.positions[index * 3 + 1], z: geometry.positions[index * 3 + 2] });
          }
          lines.push(line);
        }
        mesh = createLineSystem(engine, { name: first.name, lines,
          material: material as ReturnType<typeof createLineMaterial> });
      } else {
        const shared = sharedGeometryFor(first.geometry);
        mesh = createMeshFromData(engine, first.name, shared.positions, shared.normals,
          shared.indices, shared.uvs);
        mesh.material = material;
      }
      // Frozen null means the source decided caster status from the material at runtime
      // (legacy-site.ts:isCaster): alpha-blended and refracted surfaces never cast.
      const definition = source.materials[first.material];
      mesh.metadata = { staticShadowCaster: first.caster ?? (definition.alpha >= 1 && !definition.refraction) };
      mesh.receiveShadows = first.receiveShadows;
      // Source legacy-site.ts:406-407 disables the early procedural air-shower approximation
      // once the original airlocks are restored: keep the frozen vertices, never display them.
      const sourceDisabled = first.name.startsWith('airshower-');
      setParent(mesh, sourceDisabled ? sourceDisabledRoot : roots[first.layer]);
      if (sourceDisabled) setSubtreeVisible(mesh, false);
      const matrices = new Float32Array(entities.length * 16);
      entities.forEach((entity, instanceIndex) => {
        matrices.set(entity.matrix, instanceIndex * 16);
        parts.push({ name: entity.name, layer: entity.layer, mesh, instanceIndex });
      });
      if (source.materials[first.material].alpha < 1 || first.name === 'procedural-floor') {
        // Lite sorts transparent draws by mesh.worldMatrix, excluding thin matrices.
        // The cleanroom floor also becomes transparent on level changes.
        const { translation, rotation, scale } = decomposeMat4(matrices as unknown as Mat4);
        mesh.position.set(translation.x, translation.y, translation.z);
        mesh.rotationQuaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
        mesh.scaling.set(scale.x, scale.y, scale.z);
      } else {
        setThinInstances(mesh, matrices, entities.length);
        enableThinInstanceWorldBounds(mesh);
      }
      addToScene(scene, mesh);
      batches.push(mesh);
    }
    const lights = source.lights.map(definition => {
      const light = createPointLight(definition.position, definition.intensity);
      light.name = definition.name; light.diffuse = definition.color; light.specular = definition.specular;
      light.range = definition.range;
      light.metadata = { legacyDecay: definition.legacyDecay }; // Retain the source falloff input for P4.
      setParent(light, lightRoot);
      addToScene(scene, light);
      return light;
    });
    return {
      parts, batches, roots, lightRoot, lights, dispose,
      setVisible(layer, visible) { setSubtreeVisible(roots[layer], visible); },
      setOffset(layer, y) { roots[layer].position.y = y; if (layer === 'b1') lightRoot.position.y = y; },
      async setLevel(level: 'L1' | 'B1' | 'DUAL' | 'EXPLODED') {
        // Next legacy-site.ts:syncLevel: retain L1; DUAL never explodes B1; EXPLODED lifts B1.
        setSubtreeVisible(roots.shell, true);
        setSubtreeVisible(roots.b1, level !== 'L1');
        roots.b1.position.y = 0; lightRoot.position.y = 0;
        const slab = parts.find(part => part.name === 'procedural-slab')!.mesh;
        setSubtreeVisible(slab, level === 'L1');
        const floor = parts.find(part => part.name === 'procedural-floor')!.mesh;
        const material = floor.material as PbrMaterialProps;
        const blended = level !== 'L1', changed = !!material.alphaBlend !== blended;
        material.alpha = originalFloorOpacity(level);
        material.alphaBlend = blended;
        if (changed) await rebuildMaterial(scene, material);
        else markMaterialUboDirty(material);
      },
      prepareForDeviceRecovery() {
        for (const mesh of batches) {
          const instances = mesh.thinInstances;
          if (!instances) continue;
          mesh.thinInstances = null;
          setThinInstances(mesh, instances.matrices, instances.count);
          if (instances.colors) setThinInstanceColors(mesh, instances.colors);
        }
      },
    };
  } catch (error) { dispose(); throw error; }
}
