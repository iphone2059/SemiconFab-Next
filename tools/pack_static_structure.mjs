#!/usr/bin/env node
/**
 * Packs the frozen static-structure source of truth into a generated TypeScript module.
 *
 * Why: web_app/assets/lite-static-structure.json is imported on the WebGPU cold-start path.
 * Vite/rolldown turns that 2.2 MiB JSON into JS, and the parsed number[] geometry is then
 * converted to typed arrays once per draw batch. The generated module stores vertex buffers as
 * little-endian Float32/Uint32 base64 payloads and decodes them synchronously at module
 * evaluation (no fetch; works in Node/Vitest and the browser), while materials/entities/lights
 * stay compact JSON strings parsed once.
 *
 * The generator refuses to emit a lossy payload: every source float must be exactly
 * representable as float32 (the renderer already feeds these arrays through Float32Array) and
 * every index must be a uint32. tests/static-structure-pack.test.ts deep-compares the decoded
 * module against the committed JSON asset so drift cannot land unnoticed.
 *
 * The emitted module carries data only: it imports the hand-written payload contract from
 * web_app/src/rendering/contracts/static-structure-data.ts (type-only, erased at emit) and the
 * renderer imports the same contract, so generated data never points at a rendering consumer.
 * validateContract() fails the run if that contract module or any expected export disappears.
 *
 * Usage (from the repository root):
 *   node tools/pack_static_structure.mjs              regenerate the packed module
 *   node tools/pack_static_structure.mjs --check      exit 1 when the committed module is stale
 *   node tools/pack_static_structure.mjs --measure    print parse/encode/decode timings
 *   node tools/pack_static_structure.mjs --output <path>  write elsewhere (freshness tests only)
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SOURCE_JSON = join(ROOT, 'web_app', 'assets', 'lite-static-structure.json');
const DEFAULT_OUTPUT_TS = join(ROOT, 'web_app', 'src', 'generated', 'static-structure-packed.ts');
const CONTRACT_TS = join(ROOT, 'web_app', 'src', 'rendering', 'contracts', 'static-structure-data.ts');
const CONTRACT_IMPORT = '../rendering/contracts/static-structure-data';
/** Every identifier the emitted module imports from the hand-written data contract. */
const CONTRACT_EXPORTS = ['StaticLayer', 'StaticSurfaceDefinition', 'PackedGeometry', 'PackedLightDefinition', 'PackedSourceEntity', 'PackedStaticStructure'];
const USAGE = 'usage: node tools/pack_static_structure.mjs [--check|--measure] [--output <path>]';

function fail(message) {
  throw new Error('pack_static_structure: ' + message);
}

/** The generated module imports its payload types from the hand-written contract module. */
function validateContract() {
  let text;
  try {
    text = readFileSync(CONTRACT_TS, 'utf8');
  } catch {
    fail('data contract is missing: web_app/src/rendering/contracts/static-structure-data.ts');
  }
  for (const name of CONTRACT_EXPORTS) {
    if (!new RegExp('export\\s+(?:type|interface)\\s+' + name + '\\b').test(text)) {
      fail('data contract must export ' + name + ' from web_app/src/rendering/contracts/static-structure-data.ts');
    }
  }
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function validateFloats(values, label) {
  if (!Array.isArray(values)) fail(label + ' must be an array');
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (typeof value !== 'number' || !Number.isFinite(value)) fail(label + '[' + index + '] must be a finite number');
    if (Math.fround(value) !== value) {
      fail(label + '[' + index + '] = ' + value + ' is not exactly representable as float32; refusing to emit a lossy payload');
    }
  }
}

function validateIndices(values, label) {
  if (!Array.isArray(values)) fail(label + ' must be an array');
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) fail(label + '[' + index + '] = ' + value + ' is not a uint32 index');
  }
}

function validate(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail('source must be a JSON object');
  for (const key of ['geometries', 'materials']) {
    if (!data[key] || typeof data[key] !== 'object' || Array.isArray(data[key])) fail('source.' + key + ' must be an object');
  }
  for (const key of ['entities', 'lights']) {
    if (!Array.isArray(data[key])) fail('source.' + key + ' must be an array');
  }
  for (const [id, geometry] of Object.entries(data.geometries)) {
    const label = 'geometries[' + id + ']';
    if (!geometry || typeof geometry !== 'object') fail(label + ' must be an object');
    validateFloats(geometry.positions, label + '.positions');
    validateFloats(geometry.normals, label + '.normals');
    validateFloats(geometry.uvs, label + '.uvs');
    validateIndices(geometry.indices, label + '.indices');
    if (typeof geometry.lines !== 'boolean') fail(label + '.lines must be a boolean');
    if (geometry.positions.length % 3 !== 0) fail(label + '.positions length must be a multiple of 3');
    if (geometry.uvs.length % 2 !== 0) fail(label + '.uvs length must be a multiple of 2');
    if (geometry.indices.length % 2 !== 0) fail(label + '.indices length must be a multiple of 2 (line pairs)');
    if (geometry.lines) {
      // Native line systems only consume positions + index pairs; the frozen asset stores no
      // normals/uvs for them (validated here so a future asset cannot silently change that).
      if (geometry.normals.length !== 0 || geometry.uvs.length !== 0) fail(label + ' line geometry must not carry normals/uvs');
    } else {
      if (geometry.normals.length !== geometry.positions.length) fail(label + '.normals length must match positions');
      if (geometry.indices.length % 3 !== 0) fail(label + '.indices length must be a multiple of 3 for triangle geometry');
      if (geometry.uvs.length !== 0 && geometry.uvs.length !== geometry.positions.length / 3 * 2) {
        fail(label + '.uvs length must be 0 or match the vertex count');
      }
    }
  }
  for (const [id, material] of Object.entries(data.materials)) {
    if (!material || typeof material !== 'object') fail('materials[' + id + '] must be an object');
    if (material.kind !== 'pbr' && material.kind !== 'standard' && material.kind !== 'line') fail('materials[' + id + '].kind is unknown');
  }
  for (const entity of data.entities) {
    if (!entity || typeof entity !== 'object') fail('entity must be an object');
    if (typeof entity.name !== 'string' || typeof entity.geometry !== 'string' || typeof entity.material !== 'string') {
      fail('entity ' + String(entity.name) + ' is missing name/geometry/material');
    }
    if (!data.geometries[entity.geometry]) fail('entity ' + entity.name + ' references unknown geometry ' + entity.geometry);
    if (!data.materials[entity.material]) fail('entity ' + entity.name + ' references unknown material ' + entity.material);
    if (!Array.isArray(entity.matrix) || entity.matrix.length !== 16) fail('entity ' + entity.name + '.matrix must hold 16 numbers');
    if (entity.layer !== 'shell' && entity.layer !== 'ffu' && entity.layer !== 'b1') fail('entity ' + entity.name + '.layer is unknown');
    if (entity.caster !== null && typeof entity.caster !== 'boolean') fail('entity ' + entity.name + '.caster must be boolean or null');
    if (typeof entity.receiveShadows !== 'boolean') fail('entity ' + entity.name + '.receiveShadows must be a boolean');
  }
  for (const light of data.lights) {
    if (!light || typeof light !== 'object') fail('light must be an object');
    for (const key of ['position', 'color', 'specular']) {
      if (!Array.isArray(light[key]) || light[key].length !== 3) fail('light ' + String(light.name) + '.' + key + ' must hold 3 numbers');
    }
    for (const key of ['intensity', 'range', 'legacyDecay']) {
      if (typeof light[key] !== 'number' || !Number.isFinite(light[key])) fail('light ' + String(light.name) + '.' + key + ' must be a finite number');
    }
  }
}

function encodeFloat32(values) {
  const typed = new Float32Array(values);
  return Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength).toString('base64');
}

function encodeUint32(values) {
  const typed = new Uint32Array(values);
  return Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength).toString('base64');
}

/** Base64 payloads for every geometry plus the compact JSON sections. */
function buildPayloads(data) {
  const geometries = {};
  for (const [id, geometry] of Object.entries(data.geometries)) {
    geometries[id] = {
      positions: encodeFloat32(geometry.positions),
      normals: encodeFloat32(geometry.normals),
      uvs: geometry.uvs.length > 0 ? encodeFloat32(geometry.uvs) : '',
      indices: encodeUint32(geometry.indices),
      lines: geometry.lines,
    };
  }
  return {
    geometries,
    materialsJson: JSON.stringify(data.materials),
    entitiesJson: JSON.stringify(data.entities),
    lightsJson: JSON.stringify(data.lights),
  };
}

function renderModule(sourceText, payloads) {
  const sha256 = createHash('sha256').update(sourceText).digest('hex');
  const geometryLines = [];
  for (const [id, payload] of Object.entries(payloads.geometries)) {
    geometryLines.push('  ' + JSON.stringify(id) + ': [' + JSON.stringify(payload.positions) + ', ' + JSON.stringify(payload.normals) + ', '
      + (payload.uvs ? JSON.stringify(payload.uvs) : "''") + ', ' + JSON.stringify(payload.indices) + ', ' + String(payload.lines) + '],');
  }
  const materialsJson = payloads.materialsJson;
  const entitiesJson = payloads.entitiesJson;
  const lightsJson = payloads.lightsJson;
  return [
    '// AUTO-GENERATED FILE - DO NOT EDIT BY HAND.',
    '// Source: web_app/assets/lite-static-structure.json (sha256 ' + sha256 + ')',
    '// Generator: node tools/pack_static_structure.mjs',
    '// Data contract: web_app/src/rendering/contracts/static-structure-data.ts (type-only import)',
    '// Freshness check: node tools/pack_static_structure.mjs --check',
    '//',
    '// Vertex data is stored as little-endian Float32/Uint32 base64 payloads decoded synchronously at',
    '// module evaluation (no fetch; works in Node/Vitest and the browser). The generator refuses any',
    '// value that is not exactly representable, so this module decodes to the committed JSON asset',
    '// value-for-value; tests/static-structure-pack.test.ts enforces that invariant.',
    '//',
    '// Payload types are owned by the hand-written data contract above; this module carries only data',
    '// and its decoder, so no rendering consumer is part of the generated module graph.',
    '',
    'import type {',
    '  PackedGeometry,',
    '  PackedLightDefinition,',
    '  PackedSourceEntity,',
    '  PackedStaticStructure,',
    '  StaticSurfaceDefinition,',
    "} from '" + CONTRACT_IMPORT + "';",
    '',
    'type GeometryPayload = readonly [positions: string, normals: string, uvs: string, indices: string, lines: boolean];',
    '',
    'const GEOMETRY_PAYLOADS: Record<string, GeometryPayload> = {',
    ...geometryLines,
    '};',
    '',
    'const MATERIALS_JSON = ' + JSON.stringify(materialsJson) + ';',
    '',
    'const ENTITIES_JSON = ' + JSON.stringify(entitiesJson) + ';',
    '',
    'const LIGHTS_JSON = ' + JSON.stringify(lightsJson) + ';',
    '',
    '/** Base64 payload string -> raw little-endian bytes. */',
    'function decodeBytes(payload: string): Uint8Array {',
    '  const binary = atob(payload);',
    '  const bytes = new Uint8Array(binary.length);',
    '  for (let index = 0; index < bytes.length; index += 1) bytes[index] = binary.charCodeAt(index);',
    '  return bytes;',
    '}',
    '',
    'function decodeFloat32(payload: string): Float32Array {',
    '  const bytes = decodeBytes(payload);',
    '  return new Float32Array(bytes.buffer, 0, bytes.length / 4);',
    '}',
    '',
    'function decodeUint32(payload: string): Uint32Array {',
    '  const bytes = decodeBytes(payload);',
    '  return new Uint32Array(bytes.buffer, 0, bytes.length / 4);',
    '}',
    '',
    'function decodeGeometry(payload: GeometryPayload): PackedGeometry {',
    '  return {',
    '    positions: decodeFloat32(payload[0]),',
    '    normals: decodeFloat32(payload[1]),',
    '    uvs: payload[2] ? decodeFloat32(payload[2]) : new Float32Array(0),',
    '    indices: decodeUint32(payload[3]),',
    '    lines: payload[4],',
    '  };',
    '}',
    '',
    'function decodeStaticStructure(): PackedStaticStructure {',
    '  const geometries: Record<string, PackedGeometry> = {};',
    '  for (const id of Object.keys(GEOMETRY_PAYLOADS)) geometries[id] = decodeGeometry(GEOMETRY_PAYLOADS[id]);',
    '  return {',
    '    geometries,',
    '    materials: JSON.parse(MATERIALS_JSON) as Record<string, StaticSurfaceDefinition>,',
    '    entities: JSON.parse(ENTITIES_JSON) as PackedSourceEntity[],',
    '    lights: JSON.parse(LIGHTS_JSON) as PackedLightDefinition[],',
    '  };',
    '}',
    '',
    '/** Packed source-of-truth data for the lite static structure scene. */',
    'export const staticStructure: PackedStaticStructure = decodeStaticStructure();',
    '',
  ].join('\n');
}

/** Byte-for-byte mirror of the generated module's decode path, measured in-memory. */
function decodeBytesForMeasure(payload) {
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function decodeFloat32ForMeasure(payload) {
  const bytes = decodeBytesForMeasure(payload);
  return new Float32Array(bytes.buffer, 0, bytes.length / 4);
}

function decodeUint32ForMeasure(payload) {
  const bytes = decodeBytesForMeasure(payload);
  return new Uint32Array(bytes.buffer, 0, bytes.length / 4);
}

function decodePayloadsForMeasure(payloads) {
  const geometries = {};
  for (const id of Object.keys(payloads.geometries)) {
    const payload = payloads.geometries[id];
    geometries[id] = {
      positions: decodeFloat32ForMeasure(payload.positions),
      normals: decodeFloat32ForMeasure(payload.normals),
      uvs: payload.uvs ? decodeFloat32ForMeasure(payload.uvs) : new Float32Array(0),
      indices: decodeUint32ForMeasure(payload.indices),
      lines: payload.lines,
    };
  }
  return {
    geometries,
    materials: JSON.parse(payloads.materialsJson),
    entities: JSON.parse(payloads.entitiesJson),
    lights: JSON.parse(payloads.lightsJson),
  };
}

async function measureMode(sourceText, payloads, content, payloadsMs, renderMs) {
  const { gzipSync } = await import('node:zlib');
  const parseTimes = [];
  for (let run = 0; run < 7; run += 1) {
    const started = performance.now();
    JSON.parse(sourceText);
    parseTimes.push(performance.now() - started);
  }
  const decodeTimes = [];
  let decoded;
  for (let run = 0; run < 9; run += 1) {
    const started = performance.now();
    decoded = decodePayloadsForMeasure(payloads);
    decodeTimes.push(performance.now() - started);
  }
  if (decoded.entities.length !== JSON.parse(payloads.entitiesJson).length
    || Object.keys(decoded.geometries).length !== Object.keys(payloads.geometries).length) {
    fail('decoded payloads do not match the generated structure');
  }
  console.log('encode payloads:          ' + payloadsMs.toFixed(2) + ' ms');
  console.log('render generated source:  ' + renderMs.toFixed(2) + ' ms');
  console.log('source JSON.parse:        ' + median(parseTimes).toFixed(2) + ' ms (median of 7)');
  console.log('packed decode (in-memory):' + median(decodeTimes).toFixed(2) + ' ms (median of 9; same operations as module decode, excluding bundle transfer)');
  console.log('source bytes:             ' + Buffer.byteLength(sourceText) + ' (' + (Buffer.byteLength(sourceText) / 1048576).toFixed(2) + ' MiB)');
  console.log('generated source bytes:   ' + Buffer.byteLength(content) + ' (' + (Buffer.byteLength(content) / 1048576).toFixed(2) + ' MiB)');
  console.log('gzip source/generated:    ' + gzipSync(sourceText).length + ' / ' + gzipSync(content).length + ' bytes');
}

function parseArguments(argv) {
  const options = { mode: 'write', output: DEFAULT_OUTPUT_TS };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--check' || argument === '--measure') {
      const mode = argument === '--check' ? 'check' : 'measure';
      if (options.mode !== 'write' && options.mode !== mode) fail('cannot combine --check and --measure');
      options.mode = mode;
    } else if (argument === '--output') {
      const output = argv[index + 1];
      if (output === undefined || output === '') fail('--output requires a path');
      options.output = resolve(process.cwd(), output);
      index += 1;
    } else {
      fail('unknown argument ' + JSON.stringify(argument) + '\n' + USAGE);
    }
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const sourceText = readFileSync(SOURCE_JSON, 'utf8');
  const data = JSON.parse(sourceText);
  validate(data);
  validateContract();
  const payloadsStarted = performance.now();
  const payloads = buildPayloads(data);
  const payloadsMs = performance.now() - payloadsStarted;
  const renderStarted = performance.now();
  const content = renderModule(sourceText, payloads);
  const renderMs = performance.now() - renderStarted;
  const outputLabel = options.output === DEFAULT_OUTPUT_TS ? 'static-structure-packed.ts' : options.output;
  if (options.mode === 'check') {
    let existing = '';
    try {
      existing = readFileSync(options.output, 'utf8');
    } catch {
      fail('committed module is missing: ' + options.output);
    }
    if (existing !== content) {
      console.error(outputLabel + ' is stale; run: node tools/pack_static_structure.mjs');
      process.exitCode = 1;
      return;
    }
    console.log(outputLabel + ' is up to date (' + Buffer.byteLength(content) + ' bytes).');
    return;
  }
  if (options.mode === 'measure') {
    await measureMode(sourceText, payloads, content, payloadsMs, renderMs);
    return;
  }
  mkdirSync(dirname(options.output), { recursive: true });
  writeFileSync(options.output, content, 'utf8');
  console.log('wrote ' + options.output);
  console.log('  source JSON: ' + Buffer.byteLength(sourceText) + ' bytes');
  console.log('  generated:   ' + Buffer.byteLength(content) + ' bytes (encoded in ' + (payloadsMs + renderMs).toFixed(2) + ' ms)');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
