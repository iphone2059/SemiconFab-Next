import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Constants } from '@babylonjs/core/Engines/constants';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import type { Scene } from '@babylonjs/core/scene';
import type { PatrolFrame } from './personnel-timeline';

export interface PatrolBillboard {
  readonly mesh: Mesh;
  update(frame: PatrolFrame, language: 'zh' | 'en'): void;
}

/**
 * Frozen twin.html createPatrolStatusCanvas/createPatrolStatusSprite.
 * The original buildCleanroomPersonnel overwrites the actor userData, leaving
 * statusSprite unavailable to the later update function (as-built behavior).
 * Match that visible initial sprite. Only redraw for locale, not for later
 * as-built timeline transitions. A preserved-userData future mode may opt in
 * to dynamic status updates, but should be separately Golden-reviewed.
 */
export function buildOriginalPatrolBillboard(scene: Scene, parent: TransformNode): PatrolBillboard {
  const width = 512, height = 128;
  const mesh = MeshBuilder.CreatePlane('original-patrol-status', { width: 3.2, height: 0.8 }, scene);
  mesh.parent = parent;
  mesh.position.y = 2.15;
  mesh.billboardMode = Mesh.BILLBOARDMODE_ALL;
  mesh.isPickable = false;
  mesh.metadata = { staticShadowCaster: false, originalPatrolStatus: true };
  const mat = new PBRMaterial('original-patrol-status-material', scene);
  mat.unlit = true;
  mat.backFaceCulling = false;
  mat.transparencyMode = PBRMaterial.PBRMATERIAL_ALPHABLEND;
  mat.useAlphaFromAlbedoTexture = true;
  mat.disableDepthWrite = true;
  mat.depthFunction = Constants.ALWAYS;
  let texture: DynamicTexture | null = null;
  let context: CanvasRenderingContext2D | null = null;
  if (typeof document !== 'undefined') {
    texture = new DynamicTexture('original-patrol-status-canvas', { width, height }, scene, true);
    context = texture.getContext() as unknown as CanvasRenderingContext2D;
    texture.hasAlpha = true;
    mat.albedoTexture = texture;
  }
  mat.albedoColor = Color3.White();
  mesh.material = mat;

  let original: Pick<PatrolFrame, 'phase' | 'statusTextZh' | 'statusTextEn'> | null = null;
  let cachedLocale: string | null = null;
  return {
    mesh,
    update(frame, language) {
      original ??= {
        phase: frame.phase,
        statusTextZh: frame.statusTextZh,
        statusTextEn: frame.statusTextEn,
      };
      if (!context || !texture || cachedLocale === language) return;
      cachedLocale = language;
      const ctx = context;
      const blowing = original.phase === 'AIR_SHOWER_CYCLE';
      const fill = blowing ? 'rgba(239, 68, 68, 0.92)' : 'rgba(15, 23, 42, 0.90)';
      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = fill;
      ctx.beginPath();
      ctx.roundRect(8, 8, 496, 112, 24);
      ctx.fill();
      ctx.strokeStyle = blowing ? '#fbbf24' : '#38bdf8';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.roundRect(8, 8, 496, 112, 24);
      ctx.stroke();
      ctx.fillStyle = blowing ? '#fef08a' : '#38bdf8';
      ctx.font = 'bold 22px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace';
      ctx.textAlign = 'left';
      ctx.fillText(blowing ? '⚡ AIR SHOWER PURGING · 28 m/s' : '● AUTONOMOUS PATROL', 24, 46);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 28px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
      ctx.fillText(language === 'zh' ? original.statusTextZh : original.statusTextEn, 24, 94);
      texture.update();
    },
  };
}
