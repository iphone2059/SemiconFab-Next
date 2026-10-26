import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Scene } from '@babylonjs/core/scene';
import { FAB_LAYOUT } from './fab-layout';
import { OriginalLegacyLightFalloff } from './original-lighting';

import { originalToolTemplate, originalEquipmentParts, type OriginalToolPart } from './original-tool-parts';
export { ORIGINAL_CATEGORY_ACCENTS, originalToolTemplate } from './original-tool-parts';

export function buildOriginalEquipment(scene: Scene, parent: TransformNode): TransformNode[] {
  const materials = new Map<string, PBRMaterial>();
  const materialFor = (part: OriginalToolPart) => {
    const key = JSON.stringify([part.color, part.metallic ?? 0.22, part.roughness ?? 0.38, part.alpha ?? 1, part.status]);
    let material = materials.get(key);
    if (!material) {
      material = new PBRMaterial(`original-tool-material-${materials.size}`, scene);
      material.albedoColor = new Color3(...part.color);
      material.metallic = part.metallic ?? 0.22; material.roughness = part.roughness ?? 0.38; material.alpha = part.alpha ?? 1;
      // The original r128 standard-light model includes PI in direct irradiance and has no IBL.
      material.directIntensity = Math.PI;
      material.environmentIntensity = 0;
      material.ambientColor = Color3.White();
      material.maxSimultaneousLights = 8;
      new OriginalLegacyLightFalloff(material);
      if (part.status) material.emissiveColor = new Color3(...part.color).scale(0.9);
      if (material.alpha < 1) material.disableDepthWrite = true;
      materials.set(key, material);
    }
    return material;
  };
  return FAB_LAYOUT.map((tool, index) => {
    const group = new TransformNode(`procedural-tool-${index}`, scene);
    group.parent = parent;
    group.position.set(tool.x, tool.originalKind === 'draft' ? 0.12 : 0, tool.z);
    group.rotation.y = tool.rotationDegrees * Math.PI / 180;
    group.metadata = { toolIndex: index, recordId: tool.recordId };
    const template = originalToolTemplate(tool);
    const parts = originalEquipmentParts(tool);
    parts.forEach((part, partIndex) => {
      const status = part.status || tool.originalKind === 'draft' && partIndex >= template.parts.length;
      const name = part.status ? `status-${index}` : status ? `status-pole-${index}` : `original-tool-${index}-part-${partIndex}`;
      const mesh = part.shape === 'box'
        ? MeshBuilder.CreateBox(name, { width: part.size[0], height: part.size[1], depth: part.size[2] }, scene)
        : MeshBuilder.CreateCylinder(name, { diameterTop: part.size[0] * 2, diameterBottom: part.size[2] * 2, height: part.size[1], tessellation: part.segments }, scene);
      mesh.parent = group; mesh.position.set(...part.at); mesh.material = materialFor(part);
      mesh.metadata = { toolIndex: index, recordId: tool.recordId }; mesh.isPickable = true;
    });
    if (tool.originalKind === 'catalog' && tool.dimensionTier === 'inferred') {
      const w = tool.width / 2, h = tool.height / 2, d = tool.depth / 2;
      const points = [new Vector3(-w, -h, -d), new Vector3(w, -h, -d), new Vector3(w, h, -d), new Vector3(-w, h, -d),
        new Vector3(-w, -h, d), new Vector3(w, -h, d), new Vector3(w, h, d), new Vector3(-w, h, d)];
      // r128 WireframeGeometry keeps each box face's four edges and its triangle diagonal.
      const edges = [[6,5],[2,5],[6,2],[5,1],[2,1],[3,0],[7,0],[3,7],[0,4],[7,4],
        [3,7],[2,7],[3,2],[7,6],[2,6],[4,0],[5,0],[4,5],[0,1],[5,1],
        [7,4],[6,4],[7,6],[4,5],[6,5],[2,1],[3,1],[2,3],[1,0],[3,0]];
      const wire = MeshBuilder.CreateLineSystem(`original-tool-${index}-wire`, { lines: edges.map(([a,b]) => [points[a],points[b]]) }, scene);
      wire.position.y = 0.12 + tool.height / 2; wire.parent = group;
      wire.color = Color3.FromHexString('#d97706'); wire.alpha = 0.75; wire.isPickable = false;
    }
    return group;
  });
}
