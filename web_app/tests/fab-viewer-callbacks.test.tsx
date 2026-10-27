// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { FabViewport } from '../src/features/twin/fab-viewer';
import { resetRuntimeStore } from '../src/state/runtimeStore';
import type { SiteDto, FabDto } from '../src/contracts';
import type { FabToolState } from '../src/fab-layout';
import type { AmhsStats, PickedTool } from '../src/fab-scene';

// Only the GPU backend boundary is doubled: mount() captures the callbacks the
// long-lived scene keeps, so a test can invoke them after later renders.
const backend = vi.hoisted(() => ({
  mounts: [] as Array<{
    status: (value: string) => void;
    pick: (tool: PickedTool | null) => void;
    stats: (stats: AmhsStats) => void;
  }>,
}));
vi.mock('../src/lite-backend', () => ({
  createLiteBackend: () => ({
    mount(
      _canvas: unknown,
      _fabs: unknown,
      _signal: unknown,
      status: (value: string) => void,
      pick: (tool: PickedTool | null) => void,
      stats: (stats: AmhsStats) => void,
    ) {
      backend.mounts.push({ status, pick, stats });
      status('WebGPU · ready');
      return Promise.resolve();
    },
    dispose() {},
  }),
}));

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
  backend.mounts.length = 0;
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
  await waitFor(() => expect(backend.mounts).toHaveLength(1));
  expect(onStatusA).toHaveBeenCalledWith('WebGPU · ready');
  // The mount-time clear keeps its original semantics (mount effect + fabId
  // clear effect both emit the initial undefined clear).
  expect(onToolA).toHaveBeenCalledWith(undefined);
  const initialToolACalls = onToolA.mock.calls.length;
  const mounted = backend.mounts[0];

  // Same site/fab/generation: callbacks change, the GPU scene must not remount.
  view.rerender(createElement(FabViewport, {
    ...baseProps, onToolChange: onToolB, onStatusChange: onStatusB, onAmhsStatsChange: onAmhsB,
  }));
  expect(backend.mounts).toHaveLength(1);

  await act(async () => { mounted.pick(picked); });
  expect(onToolB).toHaveBeenCalledWith(picked);
  expect(onToolA).toHaveBeenCalledTimes(initialToolACalls);

  await act(async () => { mounted.status('WebGPU · recovered'); });
  expect(onStatusB).toHaveBeenCalledWith('WebGPU · recovered');
  expect(onStatusA).not.toHaveBeenCalledWith('WebGPU · recovered');

  await act(async () => { mounted.stats(amhs); });
  expect(onAmhsB).toHaveBeenCalledWith(amhs);
  expect(onAmhsA).not.toHaveBeenCalled();

  expect(backend.mounts).toHaveLength(1);
});

it('clears the selection through the latest handler when the FAB changes', async () => {
  const onToolA = vi.fn();
  const onToolB = vi.fn();
  const view = render(createElement(FabViewport, { ...baseProps, onToolChange: onToolA }));
  await waitFor(() => expect(backend.mounts).toHaveLength(1));
  const initialUndefinedCalls = onToolA.mock.calls.filter(([tool]) => tool === undefined).length;
  expect(initialUndefinedCalls).toBeGreaterThan(0);
  const firstMount = backend.mounts[0];

  view.rerender(createElement(FabViewport, { ...baseProps, fab: fab2, onToolChange: onToolB }));
  await waitFor(() => expect(backend.mounts).toHaveLength(2));
  // The fabId-change clear effect must reach the latest handler, never the old one.
  await waitFor(() => expect(onToolB).toHaveBeenCalledWith(undefined));
  expect(onToolA.mock.calls.filter(([tool]) => tool === undefined)).toHaveLength(initialUndefinedCalls);

  // The new scene's captured callbacks follow the latest props.
  await act(async () => { backend.mounts[1].pick(picked); });
  expect(onToolB).toHaveBeenCalledWith(picked);
  expect(onToolA).not.toHaveBeenCalledWith(picked);

  // The replaced scene's callback is still epoch/abort guarded: no stale pick
  // reaches either handler after disposal.
  const callsAfterSwitch = onToolB.mock.calls.length;
  await act(async () => { firstMount.pick(picked); });
  expect(onToolB).toHaveBeenCalledTimes(callsAfterSwitch);
  expect(onToolA).not.toHaveBeenCalledWith(picked);
});
