import { afterEach, expect, it, vi } from 'vitest';
import { createWebGpuBackend } from '../src/babylon-webgpu';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine';
import { Scene } from '@babylonjs/core/scene';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
afterEach(() => vi.unstubAllGlobals());
it('loads the instancing support required by shared FAB geometry', () => {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  try {
    const template = MeshBuilder.CreateBox('tool-template', {}, scene);
    const instance = template.createInstance('fab-tool');
    expect(instance.sourceMesh).toBe(template);
    expect(instance.getTotalVertices()).toBeGreaterThan(0);
  } finally {
    scene.dispose();
    engine.dispose();
  }
});
it('rejects missing WebGPU without ever creating a graphics context', async () => {
  vi.stubGlobal('window', { isSecureContext: true });
  vi.stubGlobal('navigator', {});
  const getContext = vi.fn(() => { throw new Error('must never create a fallback context'); });
  await expect(createWebGpuBackend().mount({ getContext } as unknown as HTMLCanvasElement, [], new AbortController().signal, () => {})).rejects.toThrow('WebGPU');
  expect(getContext).not.toHaveBeenCalled();
});
it('cancels during adapter discovery before creating a context', async () => {
  let resolve: ((value: unknown) => void) | undefined;
  vi.stubGlobal('window', { isSecureContext: true });
  vi.stubGlobal('navigator', { gpu: { requestAdapter: () => new Promise(done => { resolve = done; }) } });
  const getContext = vi.fn(() => { throw new Error('no late context'); });
  const abort = new AbortController();
  const backend = createWebGpuBackend();
  const mounted = backend.mount({ getContext } as unknown as HTMLCanvasElement, [], abort.signal, () => {});
  abort.abort(); backend.dispose(); resolve?.({});
  await mounted;
  expect(getContext).not.toHaveBeenCalled();
});
