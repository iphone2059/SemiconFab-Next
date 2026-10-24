import { Color3 } from '@babylonjs/core/Maths/math.color';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import type { Scene } from '@babylonjs/core/scene';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import { buildOriginalEquipment } from './original-tool-geometry';
import { buildSubfabUtilities } from './subfab-utilities';
import { buildOriginalEnvironment } from './original-environment';

export interface ProceduralFab {
  shell: TransformNode;
  equipment: TransformNode;
  ceiling: TransformNode;
  subfab: TransformNode;
  personnel: TransformNode;
  floor: Mesh;
}

const hex = (value: string) => Color3.FromHexString(value);

function addPersonnel(scene: Scene, parent: TransformNode): void {
  const suit = new StandardMaterial('procedural-suit', scene);
  suit.diffuseColor = hex('#f8fafc');
  suit.specularColor = Color3.Black();
  const boot = new StandardMaterial('procedural-boot', scene);
  boot.diffuseColor = hex('#334155');
  boot.specularColor = Color3.Black();
  const glove = new StandardMaterial('procedural-glove', scene);
  glove.diffuseColor = hex('#0284c7');
  glove.specularColor = Color3.Black();
  const visor = new StandardMaterial('procedural-visor', scene);
  visor.diffuseColor = hex('#0284c7');
  visor.emissiveColor = hex('#38bdf8').scale(0.25);
  visor.alpha = 0.82;
  const tablet = new StandardMaterial('procedural-tablet', scene);
  tablet.diffuseColor = hex('#0f172a');
  tablet.specularColor = Color3.Black();
  const screen = new StandardMaterial('procedural-tablet-screen', scene);
  screen.diffuseColor = hex('#38bdf8');
  screen.emissiveColor = hex('#0284c7').scale(0.8);
  const operatorShadow = new StandardMaterial('procedural-operator-shadow', scene);
  operatorShadow.diffuseColor = Color3.Black();
  operatorShadow.emissiveColor = Color3.Black();
  operatorShadow.specularColor = Color3.Black();
  operatorShadow.alpha = 0.16;
  operatorShadow.disableLighting = true;
  operatorShadow.disableDepthWrite = true;
  operatorShadow.backFaceCulling = false;
  const badgeMaterials = new Map<string, StandardMaterial>();
  const badgeMaterial = (color: string) => {
    let material = badgeMaterials.get(color);
    if (!material) {
      material = new StandardMaterial(`procedural-badge-${color}`, scene);
      material.diffuseColor = hex(color);
      material.specularColor = Color3.Black();
      badgeMaterials.set(color, material);
    }
    return material;
  };

  const configs = [
    { x: -19, z: -5, rotation: 0.75, badge: '#f59e0b' },
    { x: 2, z: -4, rotation: -1.1, badge: '#a855f7' },
    { x: 23, z: -2, rotation: -0.2, badge: '#3b82f6' },
    { x: 11, z: 4, rotation: Math.PI, badge: '#10b981' },
    { x: -8, z: 21, rotation: -2.3, badge: '#06b6d4' },
    { x: -18, z: -3, rotation: 1.4, badge: '#f59e0b', patrol: true },
  ];
  const walkers: {
    group: TransformNode;
    leftLeg: TransformNode;
    rightLeg: TransformNode;
    leftArm: TransformNode;
    rightArm: TransformNode;
    phase: number;
    from: number;
    to: number;
  }[] = [];
  for (let index = 0; index < configs.length; index += 1) {
    const config = configs[index];
    const group = new TransformNode(`operator-${index}`, scene);
    group.parent = parent;
    group.position.set(config.x, 0, config.z);
    group.rotation.y = config.rotation;

    const groundShadow = MeshBuilder.CreateDisc(`operator-ground-shadow-${index}`, { radius: 0.46, tessellation: 24 }, scene);
    groundShadow.parent = group;
    groundShadow.rotation.x = Math.PI / 2;
    groundShadow.position.y = 0.06;
    groundShadow.material = operatorShadow;
    groundShadow.isPickable = false;

    const leftLegPivot = new TransformNode(`operator-leg-pivot-left-${index}`, scene);
    leftLegPivot.parent = group;
    leftLegPivot.position.set(-0.11, 0.82, 0);
    const rightLegPivot = new TransformNode(`operator-leg-pivot-right-${index}`, scene);
    rightLegPivot.parent = group;
    rightLegPivot.position.set(0.11, 0.82, 0);
    cylinder(scene, `operator-leg-left-${index}`, 0.14, 0.68, Vector3(0, -0.34, 0), suit, leftLegPivot);
    cylinder(scene, `operator-leg-right-${index}`, 0.14, 0.68, Vector3(0, -0.34, 0), suit, rightLegPivot);
    box(scene, `operator-boot-left-${index}`, 0.14, 0.14, 0.26, Vector3(0, -0.75, 0.02), boot, leftLegPivot);
    box(scene, `operator-boot-right-${index}`, 0.14, 0.14, 0.26, Vector3(0, -0.75, 0.02), boot, rightLegPivot);
    box(scene, `operator-torso-${index}`, 0.38, 0.66, 0.24, Vector3(0, 1.15, 0), suit, group);
    box(scene, `operator-badge-${index}`, 0.08, 0.11, 0.02, Vector3(0.1, 1.32, 0.125), badgeMaterial(config.badge), group);
    box(scene, `operator-visormount-${index}`, 0.22, 0.08, 0.13, Vector3(0, 1.63, 0.1), visor, group);
    box(scene, `operator-mask-${index}`, 0.18, 0.08, 0.11, Vector3(0, 1.54, 0.09), suit, group);
    const hood = MeshBuilder.CreateSphere(`operator-hood-${index}`, { diameter: 0.3, segments: 12 }, scene);
    hood.parent = group;
    hood.position.set(0, 1.62, 0);
    hood.scaling.set(1, 1.1, 1.05);
    hood.material = suit;
    hood.isPickable = false;

    const leftArmPivot = new TransformNode(`operator-arm-pivot-left-${index}`, scene);
    leftArmPivot.parent = group;
    leftArmPivot.position.set(-0.21, 1.32, 0.04);
    const rightArmPivot = new TransformNode(`operator-arm-pivot-right-${index}`, scene);
    rightArmPivot.parent = group;
    rightArmPivot.position.set(0.21, 1.32, 0.04);
    const armLeft = cylinder(scene, `operator-arm-left-${index}`, 0.1, 0.36, Vector3(0, -0.18, 0), suit, leftArmPivot);
    armLeft.rotation.z = -0.2;
    const armRight = cylinder(scene, `operator-arm-right-${index}`, 0.1, 0.36, Vector3(0, -0.18, 0), suit, rightArmPivot);
    armRight.rotation.z = 0.2;
    const handLeft = MeshBuilder.CreateSphere(`operator-hand-left-${index}`, { diameter: 0.085, segments: 8 }, scene);
    handLeft.parent = leftArmPivot;
    handLeft.position.set(-0.07, -0.36, 0.1);
    handLeft.material = glove;
    const handRight = MeshBuilder.CreateSphere(`operator-hand-right-${index}`, { diameter: 0.085, segments: 8 }, scene);
    handRight.parent = rightArmPivot;
    handRight.position.set(0.07, -0.36, 0.1);
    handRight.material = glove;
    const tabletMesh = box(scene, `operator-tablet-${index}`, 0.26, 0.18, 0.02, Vector3(0, 1.2, 0.28), tablet, group);
    tabletMesh.rotation.x = -0.55;
    box(scene, `operator-screen-${index}`, 0.23, 0.15, 0.006, Vector3(0, 1.2, 0.295), screen, group);
    if ('patrol' in config && config.patrol) {
      walkers.push({ group, leftLeg: leftLegPivot, rightLeg: rightLegPivot, leftArm: leftArmPivot, rightArm: rightArmPivot, phase: index * 1.7, from: -3, to: 15 });
    }
  }

  scene.onBeforeRenderObservable.add(() => {
    if (!parent.isEnabled()) return;
    const now = performance.now() / 1000;
    for (const walker of walkers) {
      const wave = (Math.sin(now * 0.22 + walker.phase) + 1) / 2;
      walker.group.position.z = walker.from + (walker.to - walker.from) * wave;
      walker.group.rotation.y = Math.cos(now * 0.22 + walker.phase) >= 0 ? 0 : Math.PI;
      walker.group.position.y = Math.abs(Math.sin(now * 3.2 + walker.phase)) * 0.012;
      const stride = Math.sin(now * 3.2 + walker.phase) * 0.34;
      walker.leftLeg.rotation.x = stride;
      walker.rightLeg.rotation.x = -stride;
      walker.leftArm.rotation.x = -stride * 0.65;
      walker.rightArm.rotation.x = stride * 0.65;
    }
  });
}

export function buildProceduralFab(scene: Scene): ProceduralFab {
  const shell = new TransformNode('procedural-shell', scene);
  const equipment = new TransformNode('procedural-equipment', scene);
  const ceiling = new TransformNode('procedural-ceiling', scene);
  const subfab = new TransformNode('procedural-subfab', scene);
  const personnel = new TransformNode('procedural-personnel', scene);
  const floor = buildOriginalEnvironment(scene, shell);

  buildOriginalEquipment(scene, equipment);
  const dark = new StandardMaterial('procedural-shell-dark', scene);
  dark.diffuseColor = hex('#334155');
  dark.specularColor = Color3.Black();
  const metal = new StandardMaterial('procedural-shell-metal', scene);
  metal.diffuseColor = hex('#8fa3b6');
  metal.specularColor = new Color3(0.4, 0.44, 0.48);

  const wallMaterial = new StandardMaterial('procedural-perimeter-wall', scene);
  wallMaterial.diffuseColor = hex('#e6eef7');
  wallMaterial.emissiveColor = hex('#e6eef7').scale(0.12);
  wallMaterial.specularColor = Color3.Black();
  const wallGlass = new StandardMaterial('procedural-perimeter-glass', scene);
  wallGlass.diffuseColor = hex('#b9d9ee');
  wallGlass.emissiveColor = hex('#b9d9ee').scale(0.2);
  wallGlass.alpha = 0.32;
  wallGlass.backFaceCulling = false;
  box(scene, 'perimeter-wall-rear', 92, 2.6, 0.26, Vector3(0, 1.3, -37), wallMaterial, shell);
  box(scene, 'perimeter-wall-left', 0.26, 2.6, 72, Vector3(-47, 1.3, 0), wallMaterial, shell);
  box(scene, 'perimeter-wall-right', 0.26, 2.6, 72, Vector3(47, 1.3, 0), wallMaterial, shell);
  box(scene, 'perimeter-glass-rear', 82, 0.8, 0.06, Vector3(0, 1.65, -36.85), wallGlass, shell);
  box(scene, 'perimeter-kick-rear', 92, 0.16, 0.3, Vector3(0, 0.08, -37), dark, shell);
  for (const doorX of [-32, 0, 32]) {
    box(scene, `perimeter-door-${doorX}`, 2.2, 2.2, 0.1, Vector3(doorX, 1.12, -36.82), wallGlass, shell);
    box(scene, `perimeter-door-frame-left-${doorX}`, 0.1, 2.32, 0.12, Vector3(doorX - 1.15, 1.16, -36.8), metal, shell);
    box(scene, `perimeter-door-frame-right-${doorX}`, 0.1, 2.32, 0.12, Vector3(doorX + 1.15, 1.16, -36.8), metal, shell);
    box(scene, `perimeter-door-frame-top-${doorX}`, 2.4, 0.1, 0.12, Vector3(doorX, 2.3, -36.8), metal, shell);
  }

  const showerGlass = new StandardMaterial('procedural-airshower-glass', scene);
  showerGlass.diffuseColor = hex('#9fd8f2');
  showerGlass.emissiveColor = hex('#9fd8f2').scale(0.2);
  showerGlass.alpha = 0.26;
  showerGlass.backFaceCulling = false;
  showerGlass.specularColor = new Color3(0.3, 0.4, 0.45);
  const showerFrame = new StandardMaterial('procedural-airshower-frame', scene);
  showerFrame.diffuseColor = hex('#b7c8d8');
  showerFrame.specularColor = new Color3(0.35, 0.4, 0.45);
  for (const shower of [{ x: -44, z: -10 }, { x: 44, z: 12 }]) {
    box(scene, `airshower-glass-${shower.x}`, 1.8, 2.5, 1.8, Vector3(shower.x, 1.25, shower.z), showerGlass, shell);
    box(scene, `airshower-top-${shower.x}`, 2.0, 0.16, 2.0, Vector3(shower.x, 2.58, shower.z), showerFrame, shell);
    box(scene, `airshower-base-${shower.x}`, 2.0, 0.08, 2.0, Vector3(shower.x, 0.04, shower.z), showerFrame, shell);
    for (const dx of [-0.9, 0.9]) {
      for (const dz of [-0.9, 0.9]) {
        box(scene, `airshower-post-${shower.x}-${dx}-${dz}`, 0.08, 2.5, 0.08, Vector3(shower.x + dx, 1.25, shower.z + dz), showerFrame, shell);
      }
    }
  }

  const ceilingFrame = new StandardMaterial('procedural-ceiling-frame', scene);
  ceilingFrame.diffuseColor = hex('#d4a72c');
  ceilingFrame.emissiveColor = hex('#d4a72c').scale(0.3);
  const ceilingPanel = new StandardMaterial('procedural-ceiling-panel', scene);
  ceilingPanel.diffuseColor = hex('#f8f2cf');
  ceilingPanel.emissiveColor = hex('#fff6c7').scale(0.35);
  const ceilingFan = new StandardMaterial('procedural-ceiling-fan', scene);
  ceilingFan.diffuseColor = hex('#94a3b8');
  ceilingFan.emissiveColor = hex('#cbd5e1').scale(0.18);
  for (let x = -44; x <= -10; x += 4) {
    for (let z = -34; z <= 0; z += 4) {
      box(scene, `ceiling-frame-${x}-${z}`, 3.2, 0.12, 3.2, Vector3(x, 5.2, z), ceilingFrame, ceiling);
      box(scene, `ceiling-panel-${x}-${z}`, 2.9, 0.13, 2.9, Vector3(x, 5.19, z), ceilingPanel, ceiling);
      cylinder(scene, `ceiling-fan-${x}-${z}`, 1.1, 0.06, Vector3(x, 5.08, z), ceilingFan, ceiling);
      cylinder(scene, `ceiling-hub-${x}-${z}`, 0.3, 0.08, Vector3(x, 5.04, z), ceilingFrame, ceiling);
    }
  }

  const beamMaterial = new StandardMaterial('procedural-ceiling-beam', scene);
  beamMaterial.diffuseColor = hex('#d7e2ee');
  beamMaterial.emissiveColor = hex('#d7e2ee').scale(0.12);
  for (let x = -45; x <= 45; x += 9) {
    box(scene, `ceiling-beam-x-${x}`, 0.18, 0.16, 72, Vector3(x, 5.45, 0), beamMaterial, ceiling);
  }
  for (let z = -33; z <= 33; z += 9) {
    box(scene, `ceiling-beam-z-${z}`, 90, 0.16, 0.18, Vector3(0, 5.44, z), beamMaterial, ceiling);
  }

  const pipeMaterial = new StandardMaterial('procedural-pipe-material', scene);
  pipeMaterial.diffuseColor = hex('#6e8fa7');
  pipeMaterial.specularColor = new Color3(0.3, 0.32, 0.34);
  const tankMaterial = new StandardMaterial('procedural-tank-material', scene);
  tankMaterial.diffuseColor = hex('#9db3c4');
  tankMaterial.specularColor = new Color3(0.25, 0.27, 0.3);
  box(scene, 'procedural-subfab-slab', 114, 0.3, 84, Vector3(0, -7.15, 0), tankMaterial, subfab);
  for (let index = 0; index < 10; index += 1) {
    const x = -38 + index * 8.4;
    cylinder(scene, `subfab-riser-${index}`, 0.32, 2.7, Vector3(x, -1.35, 18), pipeMaterial, subfab);
    box(scene, `subfab-cabinet-${index}`, 1.2, 1.6, 0.7, Vector3(x, -6.2, -28), tankMaterial, subfab);
  }
  cylinder(scene, 'subfab-header-a', 0.42, 78, Vector3(0, -2.35, 18), pipeMaterial, subfab).rotation.z = Math.PI / 2;
  cylinder(scene, 'subfab-header-b', 0.34, 78, Vector3(0, -2.15, -28), pipeMaterial, subfab).rotation.z = Math.PI / 2;
  for (let index = 0; index < 12; index += 1) {
    const x = -36 + (index % 4) * 22;
    const z = -26 + Math.floor(index / 4) * 22;
    cylinder(scene, `subfab-tank-${index}`, 1.5, 2.4, Vector3(x, -5.8, z), tankMaterial, subfab);
    cylinder(scene, `subfab-pipe-${index}`, 0.24, 20, Vector3(x + 6, -0.7, z), pipeMaterial, subfab).rotation.z = Math.PI / 2;
  }

  buildSubfabUtilities(scene, subfab);

  addPersonnel(scene, personnel);
  return { shell, equipment, ceiling, subfab, personnel, floor };
}

function box(
  scene: Scene,
  name: string,
  width: number,
  height: number,
  depth: number,
  position: { x: number; y: number; z: number },
  material: StandardMaterial,
  parent?: TransformNode,
): Mesh {
  const mesh = MeshBuilder.CreateBox(name, { width, height, depth }, scene);
  mesh.position.set(position.x, position.y, position.z);
  mesh.material = material;
  mesh.isPickable = false;
  if (parent) mesh.parent = parent;
  return mesh;
}

function cylinder(
  scene: Scene,
  name: string,
  diameter: number,
  height: number,
  position: { x: number; y: number; z: number },
  material: StandardMaterial,
  parent?: TransformNode,
): Mesh {
  const mesh = MeshBuilder.CreateCylinder(name, { diameter, height, tessellation: 20 }, scene);
  mesh.position.set(position.x, position.y, position.z);
  mesh.material = material;
  mesh.isPickable = false;
  if (parent) mesh.parent = parent;
  return mesh;
}

function Vector3(x: number, y: number, z: number) {
  return { x, y, z };
}
