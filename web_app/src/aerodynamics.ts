import { SpriteManager } from '@babylonjs/core/Sprites/spriteManager';
import { Sprite } from '@babylonjs/core/Sprites/sprite';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { Constants } from '@babylonjs/core/Engines/constants';
import type { Scene } from '@babylonjs/core/scene';
import { FAB_LAYOUT } from './fab-layout';
import { advanceLaminarParticle, cleanroomPressureField } from './cleanroom-pressure';
import { renderAirflowHeatmapCanvas } from './airflow-texture';

/** Original 1500-particle/pressure-field demonstration, rendered with WebGPU sprites. */
export function createAerodynamics(scene: Scene) {
  const group = new TransformNode('native-airflow', scene);
  const heatmapGroup = new TransformNode('native-pressure-field', scene);
  group.setEnabled(false);
  heatmapGroup.setEnabled(false);
  const canvas = document.createElement('canvas');
  renderAirflowHeatmapCanvas(canvas);
  const texture = new DynamicTexture('pressure-field-texture', canvas, scene, false, Texture.BILINEAR_SAMPLINGMODE);
  texture.hasAlpha = true;
  texture.update(false);
  const material = new StandardMaterial('native-pressure-field-material', scene);
  material.diffuseTexture = texture;
  material.useAlphaFromDiffuseTexture = true;
  material.diffuseColor = Color3.White();
  material.emissiveColor = Color3.White();
  material.disableLighting = true;
  material.disableDepthWrite = true;
  material.backFaceCulling = false;
  material.alpha = 0.88;
  material.zOffset = -4;
  material.zOffsetUnits = -4;
  const plane = MeshBuilder.CreatePlane('airflowHeatmap', { width: 94, height: 70 }, scene);
  plane.rotation.x = Math.PI / 2;
  plane.position.y = 0.035;
  plane.material = material;
  plane.parent = heatmapGroup;
  plane.isPickable = false;

  const particleCanvas = document.createElement('canvas');
  particleCanvas.width = 64; particleCanvas.height = 128;
  const ctx = particleCanvas.getContext('2d');
  if (!ctx) throw new Error('Cannot create laminar particle texture');
  const grad = ctx.createRadialGradient(32, 64, 2, 32, 64, 28);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.2, 'rgba(186,230,253,.95)');
  grad.addColorStop(0.6, 'rgba(56,189,248,.4)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.save(); ctx.scale(0.55, 2); ctx.beginPath();
  ctx.arc(32 / 0.55, 64 / 2, 28, 0, Math.PI * 2);
  ctx.fillStyle = grad; ctx.fill(); ctx.restore();
  const manager = new SpriteManager('laminarFlowParticles', particleCanvas.toDataURL(), 1500, { width: 64, height: 128 }, scene);
  manager.blendMode = Constants.ALPHA_ADD;
  manager.disableDepthWrite = true;
  manager.isPickable = false;
  let seed = 0x464142;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
  const particles = Array.from({ length: 1500 }, (_, index) => {
    const x = -46 + random() * 92;
    const z = -34 + random() * 68;
    const y = 0.05 + random() * 7.85;
    const field = cleanroomPressureField(x, z);
    const sprite = new Sprite(`laminar-${index}`, manager);
    sprite.width = sprite.height = 0.45;
    sprite.position.set(x, y, z);
    sprite.isVisible = false;
    return { x, y, z, vy: (field.isLitho ? 0.046 : 0.036) + (random() - 0.5) * 0.008, sprite };
  });
  const obstacles = FAB_LAYOUT.map((tool) => ({ x: tool.x, z: tool.z, halfW: tool.width / 2 + 0.35, halfL: tool.depth / 2 + 0.35, topY: tool.height }));
  let enabled = false;
  let clock = 0;
  let lastTextureUpdate = 0;
  const lithoColor = new Color4(0.98, 0.75, 0.14, 0.72);
  const airlockColor = new Color4(0.98, 0.55, 0.2, 0.72);
  const bayColor = new Color4(0.22, 0.74, 0.98, 0.72);
  scene.onBeforeRenderObservable.add(() => {
    const active = group.isEnabled();
    if (active !== enabled) {
      for (const particle of particles) particle.sprite.isVisible = active;
      enabled = active;
    }
    if (!active && !heatmapGroup.isEnabled()) return;
    const dt = Math.min(0.05, scene.getEngine().getDeltaTime() / 1000);
    clock += dt;
    if (active) for (const particle of particles) {
      advanceLaminarParticle(particle, dt, obstacles, random);
      particle.sprite.position.set(particle.x, particle.y, particle.z);
      const field = cleanroomPressureField(particle.x, particle.z);
      particle.sprite.color = field.pressure >= 26 ? lithoColor : field.isAirlock ? airlockColor : bayColor;
    }
    if (heatmapGroup.isEnabled() && clock - lastTextureUpdate >= 0.1) {
      renderAirflowHeatmapCanvas(canvas, clock);
      texture.update(false);
      lastTextureUpdate = clock;
    }
  });
  return { group, heatmap: { group: heatmapGroup } };
}
