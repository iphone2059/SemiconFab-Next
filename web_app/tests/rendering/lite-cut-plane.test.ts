import { expect, it, vi } from 'vitest';
vi.hoisted(() => Object.assign(globalThis, {
  GPUBufferUsage: { VERTEX: 32, INDEX: 16, COPY_DST: 8, UNIFORM: 64 },
  GPUTextureUsage: { RENDER_ATTACHMENT: 16, TEXTURE_BINDING: 4 },
}));
import { readFileSync } from 'node:fs';
import {
  createBox, createPbrMaterial, createShaderMaterial, createStandardMaterial,
  type EngineContext, type MaterialPlugin,
} from '@babylonjs/lite';
import { createLiteCutPlane, type LiteCutPlane } from '../../src/rendering/lite/cut-plane';

/** Minimal device surface: material plugins never touch the GPU until a scene is built. */
function harness() {
  const device = {
    queue: { writeBuffer() {} },
    createBuffer({ size }: { size: number }) {
      const data = new ArrayBuffer(size);
      return { size, getMappedRange: () => data, unmap() {}, destroy() {} };
    },
    createSampler: () => ({}),
    createTexture: () => ({ width: 2048, height: 2048, createView: () => ({}), destroy() {} }),
  };
  const engine = { _renderingContexts: [], _device: device } as unknown as EngineContext;
  return { engine };
}

const UBO_OFFSETS = new Map<string, number>([['cutPlane', 0], ['cutPlaneActive', 16]]);

/** Read the plane exactly as the engine writes it into the host UBO slice (byte offsets). */
function readPluginPlane(plugin: MaterialPlugin) {
  const data = new Float32Array(5);
  plugin.writeUbo?.(data, UBO_OFFSETS);
  return { active: data[4], plane: Array.from(data.subarray(0, 4)) };
}
function readPlane(cut: LiteCutPlane) {
  return { pbr: readPluginPlane(cut.pbr), standard: readPluginPlane(cut.standard) };
}

it('converts the source cut to the exact render-space plane literals used by effects', () => {
  const cut = createLiteCutPlane();
  const cases = [
    { active: true, axis: 'Z' as const, position: 12, invert: false, plane: [0, 0, -1, -12], flag: 1 },
    { active: true, axis: 'Z' as const, position: -100, invert: true, plane: [0, 0, 1, -60], flag: 1 },
    { active: true, axis: 'X' as const, position: 100, invert: true, plane: [-1, 0, 0, 60], flag: 1 },
    { active: true, axis: 'Y' as const, position: 4, invert: false, plane: [0, 1, 0, -4], flag: 1 },
    // Source clamp (-60..60) applies before the axis/invert conversion.
    { active: true, axis: 'X' as const, position: 100, invert: false, plane: [1, 0, 0, -60], flag: 1 },
    { active: true, axis: 'Y' as const, position: -100, invert: false, plane: [0, 1, 0, 60], flag: 1 },
    { active: false, axis: 'Z' as const, position: 0, invert: false, plane: [0, 0, 0, 0], flag: 0 },
  ];
  for (const entry of cases) {
    cut.setPlane(entry.active, entry.axis, entry.position, entry.invert);
    const state = readPlane(cut);
    expect(state.pbr.plane).toEqual(entry.plane);
    expect(state.pbr.active).toBe(entry.flag);
    expect(state.standard.plane).toEqual(entry.plane);
    expect(state.standard.active).toBe(entry.flag);
  }
});

it('attaches exactly one family plugin per material, idempotently, preserving existing plugins', () => {
  const h = harness();
  const cut = createLiteCutPlane();
  const existing: MaterialPlugin = { name: 'existing-plugin' };
  const pbrMaterial = createPbrMaterial();
  pbrMaterial.plugins = [existing];
  const standardMaterial = createStandardMaterial();
  const pbrMesh = createBox(h.engine);
  pbrMesh.material = pbrMaterial;
  const standardMesh = createBox(h.engine);
  standardMesh.material = standardMaterial;

  cut.attach([pbrMesh, standardMesh]);
  cut.attach([pbrMesh, standardMesh]);

  expect(pbrMaterial.plugins).toHaveLength(2);
  expect(pbrMaterial.plugins![0]).toBe(existing);
  expect(pbrMaterial.plugins![1]).toBe(cut.pbr);
  expect(standardMaterial.plugins).toEqual([cut.standard]);

  // Materials outside the two native families are left untouched (ShaderMaterial has no plugin slot).
  const shaderMaterial = createShaderMaterial({
    name: 'cut-plane-unrelated',
    vertexSource: '@vertex fn mainVertex() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0); }',
    fragmentSource: '@fragment fn mainFragment() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }',
    attributes: ['position'],
  });
  cut.attach([{ material: shaderMaterial }]);
  expect((shaderMaterial as { plugins?: MaterialPlugin[] }).plugins).toBeUndefined();
});

it('injects the family world position and plane/active uniforms at CUSTOM_FRAGMENT_MAIN_BEGIN', () => {
  const cut = createLiteCutPlane();
  const pbrFragment = cut.pbr.getCustomCode?.('fragment') ?? {};
  const pbrBegin = pbrFragment.CUSTOM_FRAGMENT_MAIN_BEGIN ?? '';
  expect(pbrBegin).toContain('input.worldPos');
  expect(pbrBegin).toContain('material.cutPlane');
  expect(pbrBegin).toContain('discard');

  const standardFragment = cut.standard.getCustomCode?.('fragment') ?? {};
  const standardBegin = standardFragment.CUSTOM_FRAGMENT_MAIN_BEGIN ?? '';
  expect(standardBegin).toContain('input.vp');
  expect(standardBegin).toContain('pluginUbo.cutPlane');
  expect(standardBegin).toContain('discard');

  const pbrUniforms = cut.pbr.getUniforms?.().ubo ?? [];
  expect(pbrUniforms.map(field => [field.name, field.type])).toEqual([
    ['cutPlane', 'vec4<f32>'], ['cutPlaneActive', 'f32'],
  ]);
  const standardUniforms = cut.standard.getUniforms?.().ubo ?? [];
  expect(standardUniforms.map(field => [field.name, field.type])).toEqual([
    ['cutPlane', 'vec4<f32>'], ['cutPlaneActive', 'f32'],
  ]);
  // Standard plugin uniforms are re-uploaded every frame by the native dynamic path.
  expect(cut.standard.dynamic).toBe(true);
});

it('stays on public native Lite APIs (no @babylonjs/core and no three)', () => {
  const source = readFileSync(new URL('../../src/rendering/lite/cut-plane.ts', import.meta.url), 'utf8');
  expect(source).not.toContain('@babylonjs/core');
  expect(source).not.toContain("from 'three'");
  expect(source).toContain("from '@babylonjs/lite'");
});
