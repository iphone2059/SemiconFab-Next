import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRendererReady, renderGateFailures } from './render_perf_checks.mjs';

test('a canvas and RAF callbacks cannot substitute for an initialized renderer', () => {
  assert.equal(isRendererReady({ ready: 'complete', canvas: true }), false);
  const failures = renderGateFailures({ secure: true, adapter: true, canvas: true, measuredFrames: 180, p95FrameMs: 8.5, rendererFrames: 0, drawCalls: 0, rendererReady: false, gpuErrors: [] }, 180);
  assert.ok(failures.length > 0);
});

test('requires actual engine frames, draw calls, readiness and clean GPU diagnostics', () => {
  const good = { secure: true, adapter: true, canvas: true, measuredFrames: 180, p95FrameMs: 16.7, rendererFrames: 181, drawCalls: 903, rendererReady: true, gpuErrors: [] };
  assert.deepEqual(renderGateFailures(good, 180), []);
  for (const patch of [{ rendererFrames: 0 }, { drawCalls: 0 }, { rendererReady: false }, { gpuErrors: ['validation failed'] }, { measuredFrames: 0 }, { p95FrameMs: NaN }, { p95FrameMs: 101 }]) {
    assert.ok(renderGateFailures({ ...good, ...patch }, 180).length > 0);
  }
  assert.equal(isRendererReady({ ready: 'complete', canvas: true, renderer: { status: 'ready', frames: 1, drawCalls: 903 }, gpuErrors: [] }), true);
  assert.equal(isRendererReady({ ready: 'complete', canvas: true, renderer: { status: 'mounting', frames: 1, drawCalls: 903 }, gpuErrors: [] }), false);
});
