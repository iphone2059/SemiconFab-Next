import {
  addToScene, createBox, createCylinder, createLineSystem, createPbrMaterial,
  createTransformNode, setParent, setPbrEmissive, setThinInstances, enableThinInstanceWorldBounds,
  type EngineContext, type Mesh, type PbrMaterialProps, type SceneContext,
} from '@babylonjs/lite';
import { FAB_LAYOUT } from '../../../domain/fab/fab-layout';
import { TWIN_LAYOUT_IDENTITIES, type LayoutIdentity } from '../../../domain/fab/layout-identities';
import { originalEquipmentParts, type OriginalToolPart } from './original-tool-parts';

export interface EquipmentPartRef {
  readonly batchIndex: number;
  readonly instanceIndex: number;
  readonly role: 'body' | 'pole' | 'beacon' | 'wire';
}
export interface EquipmentTool extends LayoutIdentity {
  readonly layoutIndex: number;
  readonly parts: EquipmentPartRef[];
}
export interface LiteEquipment {
  readonly tools: EquipmentTool[];
  readonly batches: { readonly mesh: Mesh }[];
  resolve(mesh: Mesh, instanceIndex: number): EquipmentTool | undefined;
  /** Call from the owning runtime's lost notification, before native scene rebuilding. */
}
/** Native geometry/material batches. Placement identity never depends on batch order. */
export function createLiteEquipment(scene: SceneContext, engine: EngineContext): LiteEquipment {
  const tools: EquipmentTool[] = TWIN_LAYOUT_IDENTITIES.map((identity, layoutIndex) => ({
    ...identity, layoutIndex, parts: [],
  }));
  const batches: { mesh: Mesh; matrices: number[]; owners: EquipmentTool[] }[] = [];
  const byGeometry = new Map<string, number>();
  const materials = new Map<string, PbrMaterialProps>();
  const byMesh = new Map<Mesh, EquipmentTool[]>();

  function materialFor(part: OriginalToolPart) {
    const key = JSON.stringify([part.color, part.metallic ?? 0.22, part.roughness ?? 0.38, part.alpha ?? 1, !!part.status]);
    let material = materials.get(key);
    if (!material) {
      material = createPbrMaterial({
        baseColorFactor: [...part.color, part.alpha ?? 1],
        metallicFactor: part.metallic ?? 0.22, roughnessFactor: part.roughness ?? 0.38,
        directIntensity: Math.PI, environmentIntensity: 0, usePhysicalLightFalloff: false,
        alphaBlend: (part.alpha ?? 1) < 1,
      });
      if (part.status) setPbrEmissive(material, part.color.map(value => value * 0.9) as [number, number, number]);
      materials.set(key, material);
    }
    return material;
  }

  for (const tool of tools) {
    const layout = FAB_LAYOUT[tool.layoutIndex];
    const root = createTransformNode(tool.instanceId, layout.x, layout.originalKind === 'draft' ? 0.12 : 0, layout.z);
    root.rotation.y = layout.rotationDegrees * Math.PI / 180;
    const parts = originalEquipmentParts(layout);
    const local = createTransformNode('part');
    setParent(local, root);
    // Native setParent preserves world TRS; these parts are authored in the tool's local frame.
    local.rotationQuaternion.set(0, 0, 0, 1);
    local.scaling.set(1, 1, 1);
    function place(batchIndex: number, role: EquipmentPartRef['role']) {
      const batch = batches[batchIndex];
      const instanceIndex = batch.owners.length;
      const matrix = local.worldMatrix;
      for (let i = 0; i < 16; i++) batch.matrices.push(matrix[i]);
      batch.owners.push(tool);
      tool.parts.push({ batchIndex, instanceIndex, role });
    }
    parts.forEach((part, partIndex) => {
      const key = JSON.stringify([part.shape, part.size, part.segments, part.color,
        part.metallic ?? 0.22, part.roughness ?? 0.38, part.alpha ?? 1, !!part.status]);
      let batchIndex = byGeometry.get(key);
      if (batchIndex === undefined) {
        const mesh = part.shape === 'box'
          ? createBox(engine, { width: part.size[0], height: part.size[1], depth: part.size[2] })
          : createCylinder(engine, { diameterTop: part.size[0] * 2, diameterBottom: part.size[2] * 2,
            height: part.size[1], tessellation: part.segments });
        batchIndex = batches.length;
        mesh.name = `equipment-batch-${batchIndex}`;
        mesh.material = materialFor(part);
        mesh.receiveShadows = true;
        mesh.metadata = { staticShadowCaster: !part.status
          && !(layout.originalKind === 'draft' && partIndex >= parts.length - 2) };
        addToScene(scene, mesh); // Scene owns each allocation immediately, including partial composition failures.
        batches.push({ mesh, matrices: [], owners: [] });
        byGeometry.set(key, batchIndex);
      }
      local.position.set(...part.at);
      const role = part.status ? 'beacon' : layout.originalKind === 'draft' && partIndex === parts.length - 2 ? 'pole' : 'body';
      place(batchIndex, role);
    });
    if (layout.originalKind === 'catalog' && layout.dimensionTier === 'inferred') {
      const w = layout.width / 2, h = layout.height / 2, d = layout.depth / 2;
      const points = [[-w,-h,-d],[w,-h,-d],[w,h,-d],[-w,h,-d],[-w,-h,d],[w,-h,d],[w,h,d],[-w,h,d]];
      // Frozen r128 WireframeGeometry includes face diagonals and repeated face edges.
      const edges = [[6,5],[2,5],[6,2],[5,1],[2,1],[3,0],[7,0],[3,7],[0,4],[7,4],
        [3,7],[2,7],[3,2],[7,6],[2,6],[4,0],[5,0],[4,5],[0,1],[5,1],
        [7,4],[6,4],[7,6],[4,5],[6,5],[2,1],[3,1],[2,3],[1,0],[3,0]];
      const mesh = createLineSystem(engine, {
        name: `${tool.instanceId}-wire`, color: { r: 217 / 255, g: 119 / 255, b: 6 / 255, a: 0.75 },
        useThinInstances: true,
        lines: edges.map(edge => edge.map(index => ({ x: points[index][0], y: points[index][1], z: points[index][2] }))),
      });
      addToScene(scene, mesh);
      const batchIndex = batches.length;
      batches.push({ mesh, matrices: [], owners: [] });
      local.position.set(0, 0.12 + layout.height / 2, 0);
      place(batchIndex, 'wire');
    }
  }
  for (const batch of batches) {
    setThinInstances(batch.mesh, new Float32Array(batch.matrices), batch.owners.length);
    enableThinInstanceWorldBounds(batch.mesh);
    byMesh.set(batch.mesh, batch.owners);
  }
  return {
    tools, batches,
    resolve(mesh, instanceIndex) {
      return Number.isInteger(instanceIndex) && instanceIndex >= 0 ? byMesh.get(mesh)?.[instanceIndex] : undefined;
    },
  };
}
