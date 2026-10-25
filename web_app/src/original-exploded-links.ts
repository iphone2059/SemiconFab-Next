import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import type { Scene } from '@babylonjs/core/scene';
import { ORIGINAL_EXPLODED_LINKS, explodedLinkFrame } from './original-exploded-link-data';

export interface ExplodedLinkController {
  readonly group: TransformNode;
  setFactor(factor: number): void;
  update(timeMs: number): void;
}

/** 12 source-defined L1↔B1 reference conduits, without fabricated links. */
export function buildOriginalExplodedLinks(scene: Scene): ExplodedLinkController {
  const group = new TransformNode('original-exploded-interconnects', scene);
  const white = new StandardMaterial('original-exploded-pulse-white', scene);
  white.diffuseColor = Color3.White();
  white.emissiveColor = Color3.White();
  white.disableLighting = true;
  const entries: { tube: Mesh; ring: Mesh; phase: number }[] = [];
  ORIGINAL_EXPLODED_LINKS.forEach((record, index) => {
    const material = new PBRMaterial('original-exploded-link-' + record.subId, scene);
    const color = Color3.FromInts(record.color >>> 16 & 255, record.color >>> 8 & 255, record.color & 255);
    material.albedoColor = color;
    material.emissiveColor = color;
    material.emissiveIntensity = 0.85;
    material.metallic = 0.8;
    material.roughness = 0.2;
    material.alpha = 0.85;
    material.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
    const tube = MeshBuilder.CreateCylinder('original-interconnect-' + record.subId,
      { diameterTop: 0.28, diameterBottom: 0.28, height: 7, tessellation: 16 }, scene);
    tube.position.set((record.hostX + record.subX) / 2, -3.5, (record.hostZ + record.subZ) / 2);
    tube.material = material;
    tube.metadata = { staticShadowCaster: false, connectedTool: record.hostId, subTool: record.subId };
    tube.isPickable = false;
    tube.parent = group;
    const ring = MeshBuilder.CreateTorus('original-interconnect-ring-' + record.subId,
      { diameter: 0.56, thickness: 0.08, tessellation: 20 }, scene);
    ring.rotation.x = Math.PI / 2;
    ring.material = white;
    ring.isPickable = false;
    ring.metadata = { staticShadowCaster: false };
    ring.parent = tube;
    // The original derives pulsePhase from Math.random. Use a stable
    // independent sequence so parity captures have reproducible positions.
    const phase = ((index * 1664525 + 1013904223) >>> 0) / 2 ** 32 * Math.PI * 2;
    entries.push({ tube, ring, phase });
  });
  group.setEnabled(false);
  let factor = 0;
  return {
    group,
    setFactor(value: number) {
      factor = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
      group.setEnabled(factor >= 0.01);
    },
    update(nowMs: number) {
      if (factor < 0.01) return;
      for (const entry of entries) {
        const frame = explodedLinkFrame(factor, nowMs, entry.phase);
        entry.tube.scaling.y = frame.scaleY;
        entry.tube.position.y = frame.y;
        entry.ring.position.y = frame.ringY;
      }
    },
  };
}
