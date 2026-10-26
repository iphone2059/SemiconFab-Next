// Offline extraction only. Never imported by the application or Lite test scene.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { LinesMesh } from '@babylonjs/core/Meshes/linesMesh';
import type { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { buildProceduralFab } from '../src/procedural-fab';
import { buildOriginalSubfabFacilities } from '../src/original-subfab-facilities';
import type { OriginalPointLight } from '../src/original-lighting';

// NullEngine has no canvas implementation. Record the original drawing operations;
// this extracts the source recipe and does not claim to render texture pixels.
class CaptureCanvas {
  operations: unknown[][] = [];
  width: number; height: number;
  constructor(width: number, height: number) { this.width = width; this.height = height; }
  getContext() {
    const operations = this.operations;
    return new Proxy({}, {
      set(_target, key, value) { operations.push(['set', String(key), value]); return true; },
      get(_target, key) {
        if (key === 'measureText') return (text: string) => ({ width: text.length * 12 });
        return (...args: unknown[]) => { operations.push(['call', String(key), ...args]); };
      },
    });
  }
}
Object.assign(globalThis, { OffscreenCanvas: CaptureCanvas });
const engine = new NullEngine();
Object.defineProperty(engine, 'isWebGPU', { value: true });
const scene = new Scene(engine);
const hash = (value: unknown) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const directory = path.resolve(process.env.LITE_REFERENCE_OUTPUT ?? '../.local/lite-static-capture');
fs.mkdirSync(directory, { recursive: true });
const geometries: Record<string, unknown> = {}, materials: Record<string, unknown> = {};
const entities: unknown[] = [], expected: unknown[] = [];
try {
  const fab = buildProceduralFab(scene);
  const denseParent = new TransformNode('dense-root', scene);
  const dense = buildOriginalSubfabFacilities(scene, denseParent);
  for (const [layer, root] of [['shell', fab.shell], ['ffu', fab.ceiling], ['b1', fab.subfab], ['b1', dense.group]] as const) {
    // The original builder leaves the L1 floor/zone planes outside shell, intentionally.
    const meshes = root === fab.shell ? [...root.getChildMeshes(), ...scene.meshes.filter(mesh =>
      mesh.name === 'procedural-floor' || mesh.name.startsWith('native-zone-'))] : root.getChildMeshes();
    for (const mesh of meshes) {
      // Babylon CPU arrays can be double precision; its vertex upload is Float32.
      const positions = Array.from(new Float32Array(mesh.getVerticesData('position') ?? []));
      const normals = Array.from(new Float32Array(mesh.getVerticesData('normal') ?? []));
      const uvs = Array.from(new Float32Array(mesh.getVerticesData('uv') ?? []));
      const indices = Array.from(mesh.getIndices() ?? []);
      const geometry = { positions, normals, uvs, indices, lines: mesh instanceof LinesMesh };
      const geometryId = hash(geometry);
      geometries[geometryId] = geometry;
      let material: Record<string, unknown>;
      const source = mesh.material;
      if (mesh instanceof LinesMesh) material = { kind: 'line', color: mesh.color.asArray(), alpha: mesh.alpha };
      else if (source instanceof PBRMaterial) material = {
        kind: 'pbr', color: source.albedoColor.asArray(), alpha: source.alpha,
        metallic: source.metallic, roughness: source.roughness,
        emissive: source.emissiveColor.scale(source.emissiveIntensity).asArray(),
        doubleSided: !source.backFaceCulling, depthWrite: !source.disableDepthWrite,
        zOffset: source.zOffset, refraction: source.subSurface.isRefractionEnabled
          ? { intensity: source.subSurface.refractionIntensity, ior: source.indexOfRefraction } : null,
      };
      else if (source instanceof StandardMaterial) material = {
        kind: 'standard', color: source.diffuseColor.asArray(), alpha: source.alpha,
        emissive: source.emissiveColor.asArray(), specular: source.specularColor.asArray(), power: source.specularPower,
        doubleSided: !source.backFaceCulling, depthWrite: !source.disableDepthWrite,
      };
      else throw new Error('Unsupported original material: ' + mesh.name);
      const texture = source instanceof PBRMaterial ? source.albedoTexture : null;
      if (texture) {
        // DynamicTexture retains its caller canvas separately from the mocked 2D context.
        const operations = (texture as unknown as { _canvas: CaptureCanvas })._canvas.operations;
        const tiled = texture as Texture;
        material.texture = { width: texture.getSize().width, height: texture.getSize().height,
          uScale: tiled.uScale, vScale: tiled.vScale, gammaSpace: texture.gammaSpace, operations };
      }
      const materialId = hash(material);
      materials[materialId] = material;
      mesh.computeWorldMatrix(true);
      const matrix = mesh.getWorldMatrix().asArray();
      const bounds = mesh.getBoundingInfo().boundingBox;
      entities.push({ name: mesh.name, layer, geometry: geometryId, material: materialId, matrix: Array.from(matrix),
        caster: mesh.metadata?.staticShadowCaster ?? null, receiveShadows: mesh.receiveShadows });
      expected.push({ name: mesh.name, layer, geometryHash: geometryId, materialHash: materialId,
        min: bounds.minimumWorld.asArray(), max: bounds.maximumWorld.asArray(), matrix: Array.from(matrix) });
    }
  }
  const lights = scene.lights.filter(light => light.name.startsWith('subfab-')).map(light => {
    const point = light as unknown as { position: { asArray(): number[] }; range: number };
    return { name: light.name, position: point.position.asArray(), color: light.diffuse.asArray(),
      specular: light.specular.asArray(), intensity: light.intensity, range: point.range,
      legacyDecay: (light as OriginalPointLight).legacyDecay };
  });
  const root = path.resolve('..');
  const sources = ['web_app/src/procedural-fab.ts', 'web_app/src/original-environment.ts',
    'web_app/src/subfab-utilities.ts', 'web_app/src/original-subfab-facilities.ts'].map(file => ({
      file, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex'),
    }));
  const committedData = path.resolve('assets/lite-static-structure.json');
  const baselineCommit = fs.existsSync(committedData) ? JSON.parse(fs.readFileSync(committedData, 'utf8')).provenance.nextCommit
    : execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const provenance = { nextCommit: baselineCommit,
    source: 'Frozen Next CPU scene extraction; original attribution docs/migration/twin-parity/attribution.md', sources };
  const outputs = [
    ['static-structure-data.json', committedData, JSON.stringify({ provenance, geometries, materials, entities, lights }) + '\n'],
    ['static-structure-reference.json', path.resolve('tests/fixtures/lite-static-structure-reference.json'), JSON.stringify({ provenance, materials, entities: expected, lights }, null, 2) + '\n'],
  ];
  for (const [name, committed, content] of outputs) {
    if (process.argv.includes('--check')) {
      if (fs.readFileSync(committed, 'utf8') !== content) throw new Error('Frozen static data drift: ' + committed);
    } else fs.writeFileSync(path.join(directory, name), content);
  }
  console.log(JSON.stringify({ entities: entities.length, geometries: Object.keys(geometries).length,
    materials: Object.keys(materials).length, lights: lights.length, directory }));
} finally { scene.dispose(); engine.dispose(); }
