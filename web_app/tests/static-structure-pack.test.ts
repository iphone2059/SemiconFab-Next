import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, expect, it } from 'vitest';
import { staticStructure } from '../src/generated/static-structure-packed';

interface CommittedGeometry {
  positions: number[];
  normals: number[];
  uvs: number[];
  indices: number[];
  lines: boolean;
}
interface CommittedEntity {
  name: string;
  geometry: string;
  material: string;
}
interface CommittedStaticStructure {
  geometries: Record<string, CommittedGeometry>;
  materials: Record<string, unknown>;
  entities: CommittedEntity[];
  lights: unknown[];
}

// Read the committed asset from disk (not through a bundler JSON transform) so this is a real
// drift gate: regenerating the asset without running tools/pack_static_structure.mjs fails here.
const committed = JSON.parse(readFileSync(
  fileURLToPath(new URL('../assets/lite-static-structure.json', import.meta.url)), 'utf8',
)) as CommittedStaticStructure;

it('decodes every packed geometry to exactly the committed JSON vertex data', () => {
  expect(Object.keys(staticStructure.geometries).sort()).toEqual(Object.keys(committed.geometries).sort());
  for (const [id, source] of Object.entries(committed.geometries)) {
    const packed = staticStructure.geometries[id];
    expect(packed, id).toBeDefined();
    expect(packed.positions, id + ':positions buffer').toBeInstanceOf(Float32Array);
    expect(packed.normals, id + ':normals buffer').toBeInstanceOf(Float32Array);
    expect(packed.uvs, id + ':uvs buffer').toBeInstanceOf(Float32Array);
    expect(packed.indices, id + ':indices buffer').toBeInstanceOf(Uint32Array);
    expect(packed.lines, id + ':lines').toBe(source.lines);
    expect(Array.from(packed.positions), id + ':positions').toEqual(source.positions);
    expect(Array.from(packed.normals), id + ':normals').toEqual(source.normals);
    expect(Array.from(packed.uvs), id + ':uvs').toEqual(source.uvs);
    expect(Array.from(packed.indices), id + ':indices').toEqual(source.indices);
  }
});

it('decodes every material exactly', () => {
  expect(staticStructure.materials).toEqual(committed.materials);
});

it('decodes every entity exactly and resolves its geometry/material references', () => {
  expect(staticStructure.entities).toEqual(committed.entities);
  for (const entity of staticStructure.entities) {
    expect(staticStructure.geometries[entity.geometry], entity.name + ':geometry').toBeDefined();
    expect(staticStructure.materials[entity.material], entity.name + ':material').toBeDefined();
  }
});

it('decodes every light and keeps the frozen structure counts', () => {
  expect(staticStructure.lights).toEqual(committed.lights);
  expect(Object.keys(staticStructure.geometries)).toHaveLength(222);
  expect(Object.keys(staticStructure.materials)).toHaveLength(59);
  expect(staticStructure.entities).toHaveLength(1648);
  expect(staticStructure.lights).toHaveLength(10);
});

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const generatedDirectory = join(repoRoot, 'web_app/src/generated');
const packedPath = join(generatedDirectory, 'static-structure-packed.ts');
const contractPath = join(repoRoot, 'web_app/src/rendering/contracts/static-structure-data.ts');
const registryPath = join(repoRoot, 'tools/generated-artifacts.json');
const checkerPath = join(repoRoot, 'tools/check_generated_artifacts.mjs');
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'semiconfab-generated-artifacts-'));
afterAll(() => { rmSync(temporaryDirectory, { recursive: true, force: true }); });
const temporaryPath = (name: string): string => join(temporaryDirectory, name);
const sha256 = (buffer: Buffer): string => createHash('sha256').update(buffer).digest('hex');
const pathHash = (file: string): string => sha256(readFileSync(file));
const runNode = (arguments_: readonly string[], cwd: string = repoRoot) =>
  spawnSync(process.execPath, [...arguments_], { cwd, encoding: 'utf8' });

interface GeneratedArtifactRecord {
  path: string;
  sha256: string;
  generator: { tool: string; command: string[]; check: string[] };
  sources: { path: string; sha256: string }[];
}
interface GeneratedArtifactRegistry {
  schemaVersion: number;
  artifacts: GeneratedArtifactRecord[];
}
const readRegistry = (): GeneratedArtifactRegistry =>
  JSON.parse(readFileSync(registryPath, 'utf8')) as GeneratedArtifactRegistry;
const cloneRegistry = (registry: GeneratedArtifactRegistry): GeneratedArtifactRegistry =>
  JSON.parse(JSON.stringify(registry)) as GeneratedArtifactRegistry;
const isGeneratedArtifactName = (file: string): boolean =>
  file.endsWith('.generated.ts') || file.endsWith('.generated.tsx')
  || file.endsWith('-packed.ts') || file.endsWith('-packed.tsx');

it('registers every committed generated artifact with generator command, source inputs and sha256', () => {
  const registry = readRegistry();
  expect(registry.schemaVersion).toBe(1);
  const discovered = readdirSync(generatedDirectory).filter(isGeneratedArtifactName).sort();
  expect(registry.artifacts.map((artifact) => artifact.path.split('/').at(-1)).sort()).toEqual(discovered);
  for (const artifact of registry.artifacts) {
    expect(artifact.path, artifact.path).toMatch(/^web_app\/src\/generated\//);
    const outputPath = join(repoRoot, artifact.path);
    expect(existsSync(outputPath), artifact.path + ': output').toBe(true);
    expect(pathHash(outputPath), artifact.path + ': output sha256').toBe(artifact.sha256);
    expect(existsSync(join(repoRoot, artifact.generator.tool)), artifact.generator.tool).toBe(true);
    expect(artifact.generator.command, artifact.path + ': generator command').toContain(artifact.generator.tool);
    expect(artifact.generator.check, artifact.path + ': generator check').toContain('--check');
    expect(artifact.sources.length, artifact.path + ': sources').toBeGreaterThan(0);
    for (const source of artifact.sources) {
      const sourcePath = join(repoRoot, source.path);
      expect(existsSync(sourcePath), source.path).toBe(true);
      expect(pathHash(sourcePath), source.path + ': source sha256').toBe(source.sha256);
    }
  }
});

it('reports the committed generated tree as up to date and fails a stale registry checksum', () => {
  const fresh = runNode([checkerPath, '--check']);
  expect(fresh.status, fresh.stderr).toBe(0);
  const stale = cloneRegistry(readRegistry());
  stale.artifacts[0].sha256 = '0'.repeat(64);
  const staleRegistryPath = temporaryPath('stale-registry.json');
  writeFileSync(staleRegistryPath, JSON.stringify(stale, null, 2) + '\n');
  const result = runNode([checkerPath, '--check', '--registry', staleRegistryPath]);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('is stale');
});

it('fails the registry checker when a committed generated artifact is not registered', () => {
  const incomplete = cloneRegistry(readRegistry());
  incomplete.artifacts = incomplete.artifacts.filter((artifact) => !artifact.path.endsWith('static-structure-packed.ts'));
  const incompleteRegistryPath = temporaryPath('incomplete-registry.json');
  writeFileSync(incompleteRegistryPath, JSON.stringify(incomplete, null, 2) + '\n');
  const result = runNode([checkerPath, '--check', '--registry', incompleteRegistryPath]);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('is a generated artifact but is not registered');
});

it('re-records exactly the committed registry with --update (registry is current)', () => {
  const copiedRegistryPath = temporaryPath('registry-copy.json');
  copyFileSync(registryPath, copiedRegistryPath);
  const result = runNode([checkerPath, '--update', '--registry', copiedRegistryPath]);
  expect(result.status, result.stderr).toBe(0);
  expect(readFileSync(copiedRegistryPath, 'utf8')).toBe(readFileSync(registryPath, 'utf8'));
});

it('regenerates the committed packed artifact byte-for-byte from the frozen source asset', () => {
  const generatedPath = temporaryPath('regenerated-packed.ts');
  const result = runNode([join(repoRoot, 'tools/pack_static_structure.mjs'), '--output', generatedPath]);
  expect(result.status, result.stderr).toBe(0);
  expect(pathHash(generatedPath), 'fresh generation must be byte-stable').toBe(pathHash(packedPath));
});

it('detects a hand-edited (stale) packed artifact with --check', () => {
  const stalePath = temporaryPath('stale-packed.ts');
  writeFileSync(stalePath, readFileSync(packedPath, 'utf8') + '// hand-edited\n');
  const result = runNode([join(repoRoot, 'tools/pack_static_structure.mjs'), '--check', '--output', stalePath]);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('is stale');
});

it('binds the generated data to the hand-written contract instead of a rendering consumer', () => {
  const packed = readFileSync(packedPath, 'utf8');
  expect(packed).toContain('import type {');
  expect(packed).toContain("from '../rendering/contracts/static-structure-data';");
  expect(packed).not.toContain('rendering/lite/geometry/static-structure');
  const contract = readFileSync(contractPath, 'utf8');
  for (const name of ['PackedGeometry', 'PackedLightDefinition', 'PackedSourceEntity', 'PackedStaticStructure', 'StaticSurfaceDefinition']) {
    expect(contract, name).toContain('export interface ' + name);
  }
  expect(contract).toContain('export type StaticLayer');
});

it('every node-based registered generator reports its committed artifact as fresh', () => {
  const nodeArtifacts = readRegistry().artifacts.filter((artifact) => artifact.generator.check[0] === 'node');
  expect(nodeArtifacts.length).toBeGreaterThanOrEqual(2);
  for (const artifact of nodeArtifacts) {
    const result = runNode(artifact.generator.check.slice(1));
    expect(result.status, artifact.path + ': ' + result.stderr).toBe(0);
  }
});
