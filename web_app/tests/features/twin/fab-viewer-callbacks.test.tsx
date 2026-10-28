// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { FabViewport } from '../../../src/features/twin/fab-viewer';
import { resetRuntimeStore, useRuntimeStore } from '../../../src/state/runtimeStore';
import type { SiteDto, FabDto } from '../../../src/contracts';
import type { FabToolState } from '../../../src/domain/fab/fab-layout';
import type { AmhsStats, PickedTool } from '../../../src/application/ports/scene';
import type { ScenePortStub } from '../../support/scene-port-stub';
import { configureScenePortStub, resetScenePortStub, resolveScenePortMount } from '../../support/scene-port-stub';

// Only the GPU backend boundary is doubled by a full ScenePort stub: mount() keeps the
// readonly callbacks for the scene lifetime, so a test can invoke them after later renders.
const backend = vi.hoisted(() => ({ instances: [] as ScenePortStub[] }));
vi.mock('../../../src/rendering/lite-backend', async () => {
  const { createScenePortStub } = await import('../../support/scene-port-stub');
  return {
    createLiteBackend: () => {
      const stub = createScenePortStub();
      backend.instances.push(stub);
      return stub;
    },
  };
});

const site: SiteDto = {
  siteId: 'site-1', code: 'SITE-1', templateHash: 'test',
  fabs: [{ fabId: 'fab-1', code: 'FAB-01' }, { fabId: 'fab-2', code: 'FAB-02' }],
};
const fab1: FabDto = site.fabs[0];
const fab2: FabDto = site.fabs[1];
const toolStates: readonly FabToolState[] = ['running'];
const layers = { amhs: true, ceiling: false, roof: false, subfab: false, heatmap: false, airflow: false, xray: false };
const picked: PickedTool = { index: 3, x: 1, z: 2, width: 1, depth: 1, height: 1, category: 'litho', vendor: 'V', model: 'M', state: 'running' };
const amhs: AmhsStats = { active: 1, total: 2, queued: 0, completed: 3, avgDelivery: 1 };
const baseProps = { site, fab: fab1, toolStates, layers, explodeFactor: 0, basement: false, dual: false };

afterEach(() => {
  cleanup();
  backend.instances.length = 0;
  resetScenePortStub();
  resetRuntimeStore();
});

it('invokes the latest scene callbacks without remounting the GPU scene', async () => {
  const onToolA = vi.fn();
  const onToolB = vi.fn();
  const onStatusA = vi.fn();
  const onStatusB = vi.fn();
  const onAmhsA = vi.fn();
  const onAmhsB = vi.fn();

  const view = render(createElement(FabViewport, {
    ...baseProps, onToolChange: onToolA, onStatusChange: onStatusA, onAmhsStatsChange: onAmhsA,
  }));
  await waitFor(() => expect(backend.instances).toHaveLength(1));
  const first = backend.instances[0];
  const mount = first.mounts[0];
  // Typed mount options carry the stable viewer identity, canvas, fabs, abort signal and
  // readonly callbacks (no positional argument list any more).
  expect(mount.viewerId).toBe(useRuntimeStore.getState().viewer.epoch);
  expect(mount.canvas).toBeInstanceOf(HTMLCanvasElement);
  expect(mount.signal).toBeInstanceOf(AbortSignal);
  expect(mount.fabs).toEqual([{ fabId: 'fab-1', code: 'FAB-01', position: [0, 0, 0] }]);
  expect(onStatusA).toHaveBeenCalledWith('WebGPU · ready');
  expect(useRuntimeStore.getState().viewer.lifecycle).toBe('ready');
  expect(useRuntimeStore.getState().viewer.status).toBe('WebGPU · ready');
  // The mount-time clear keeps its original semantics (mount effect + fabId
  // clear effect both emit the initial undefined clear).
  expect(onToolA).toHaveBeenCalledWith(undefined);
  const initialToolACalls = onToolA.mock.calls.length;

  // Same site/fab/generation: callbacks change, the GPU scene must not remount.
  view.rerender(createElement(FabViewport, {
    ...baseProps, onToolChange: onToolB, onStatusChange: onStatusB, onAmhsStatsChange: onAmhsB,
  }));
  expect(backend.instances).toHaveLength(1);

  await act(async () => { mount.callbacks.onToolPick(picked); });
  expect(onToolB).toHaveBeenCalledWith(picked);
  expect(onToolA).toHaveBeenCalledTimes(initialToolACalls);

  await act(async () => { mount.callbacks.onLifecycle({ type: 'recovering', message: 'GPU 设备已丢失', cause: 'device-lost' }); });
  expect(onStatusB).toHaveBeenCalledWith('GPU 设备已丢失');
  expect(onStatusA).not.toHaveBeenCalledWith('GPU 设备已丢失');
  expect(useRuntimeStore.getState().viewer.lifecycle).toBe('recovering');

  await act(async () => { mount.callbacks.onLifecycle({ type: 'ready', message: 'WebGPU · recovered' }); });
  expect(onStatusB).toHaveBeenCalledWith('WebGPU · recovered');
  expect(onStatusA).not.toHaveBeenCalledWith('WebGPU · recovered');

  await act(async () => { mount.callbacks.onAmhsStats(amhs); });
  expect(onAmhsB).toHaveBeenCalledWith(amhs);
  expect(onAmhsA).not.toHaveBeenCalled();

  expect(backend.instances).toHaveLength(1);
});

it('clears the selection through the latest handler when the FAB changes', async () => {
  const onToolA = vi.fn();
  const onToolB = vi.fn();
  const view = render(createElement(FabViewport, { ...baseProps, onToolChange: onToolA }));
  await waitFor(() => expect(backend.instances).toHaveLength(1));
  const initialUndefinedCalls = onToolA.mock.calls.filter(([tool]) => tool === undefined).length;
  expect(initialUndefinedCalls).toBeGreaterThan(0);
  const firstPort = backend.instances[0];
  const staleMount = firstPort.mounts[0];

  view.rerender(createElement(FabViewport, { ...baseProps, fab: fab2, onToolChange: onToolB }));
  await waitFor(() => expect(backend.instances).toHaveLength(2));
  // The fabId-change clear effect must reach the latest handler, never the old one.
  await waitFor(() => expect(onToolB).toHaveBeenCalledWith(undefined));
  expect(onToolA.mock.calls.filter(([tool]) => tool === undefined)).toHaveLength(initialUndefinedCalls);
  // The replaced viewer lifetime is disposed, the new one owns a different stable identity.
  expect(firstPort.disposeCount).toBe(1);
  expect(backend.instances[1].mounts[0].viewerId).not.toBe(staleMount.viewerId);

  // The new scene's captured callbacks follow the latest props.
  await act(async () => { backend.instances[1].mounts[0].callbacks.onToolPick(picked); });
  expect(onToolB).toHaveBeenCalledWith(picked);
  expect(onToolA).not.toHaveBeenCalledWith(picked);

  // The replaced scene's callbacks are abort/epoch guarded: no stale pick or lifecycle
  // event may reach the handlers or the store after disposal.
  const callsAfterSwitch = onToolB.mock.calls.length;
  const statusCallsAfterSwitch = onToolA.mock.calls.length;
  await act(async () => {
    staleMount.callbacks.onToolPick(picked);
    staleMount.callbacks.onLifecycle({ type: 'ready', message: 'stale ready' });
  });
  expect(onToolB).toHaveBeenCalledTimes(callsAfterSwitch);
  expect(onToolA).toHaveBeenCalledTimes(statusCallsAfterSwitch);
  expect(useRuntimeStore.getState().viewer.status).not.toBe('stale ready');
  expect(useRuntimeStore.getState().viewer.lifecycle).toBe('ready');
});

it('reports a failed initialization as a failed lifecycle with display text kept separate', async () => {
  configureScenePortStub({ mode: 'failed' });
  const onStatus = vi.fn();
  render(createElement(FabViewport, { ...baseProps, onStatusChange: onStatus }));
  await waitFor(() => expect(useRuntimeStore.getState().viewer.lifecycle).toBe('failed'));
  const viewer = useRuntimeStore.getState().viewer;
  expect(viewer.status).toBe('WebGPU 初始化失败');
  expect(onStatus).toHaveBeenCalledWith('WebGPU 初始化失败');
  // The failed mount stays terminal: the status overlay offers an explicit reload and the
  // scene never reports a spurious ready state.
  expect(document.body.textContent).toContain('WebGPU 初始化失败');
  expect(document.body.textContent).toContain('重新加载');
});

it('turns a rejected mount promise into a failed lifecycle instead of staying initializing', async () => {
  configureScenePortStub({ mode: 'reject', failure: new Error('后端不可用') });
  render(createElement(FabViewport, baseProps));
  await waitFor(() => expect(useRuntimeStore.getState().viewer.lifecycle).toBe('failed'));
  expect(useRuntimeStore.getState().viewer.status).toBe('后端不可用');
});

it('ignores a late mount promise after unmount and never writes into the disposed viewer', async () => {
  configureScenePortStub({ mode: 'manual' });
  const onStatus = vi.fn();
  const view = render(createElement(FabViewport, { ...baseProps, onStatusChange: onStatus }));
  await waitFor(() => expect(backend.instances).toHaveLength(1));
  const port = backend.instances[0];
  const lateMount = port.mounts[0];
  expect(useRuntimeStore.getState().viewer.epoch).toBeDefined();

  view.unmount();
  expect(useRuntimeStore.getState().viewer.lifecycle).toBe('disposed');
  expect(useRuntimeStore.getState().viewer.epoch).toBeUndefined();
  expect(port.disposeCount).toBe(1);

  await act(async () => {
    lateMount.callbacks.onLifecycle({ type: 'ready', message: 'late ready' });
    resolveScenePortMount({ status: 'ready' });
  });
  expect(onStatus).not.toHaveBeenCalledWith('late ready');
  expect(useRuntimeStore.getState().viewer.lifecycle).toBe('disposed');
  expect(useRuntimeStore.getState().viewer.status).not.toBe('late ready');
});
