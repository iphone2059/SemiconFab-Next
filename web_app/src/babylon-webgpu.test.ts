import { afterEach, expect, it, vi } from 'vitest';
import { createWebGpuBackend } from './babylon-webgpu';
afterEach(() => vi.unstubAllGlobals());
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
