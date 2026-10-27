import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRendererReady, renderGateFailures, resolveRenderGateThresholds } from './render_perf_checks.mjs';

const goodMeasurement = (patch = {}) => ({
  secure: true, adapter: true, canvas: true, measuredFrames: 180, p95FrameMs: 8.5, p99FrameMs: 12, heapGrowthMb: 6,
  rendererFrames: 181, drawCalls: 903, rendererReady: true, gpuErrors: [], ...patch,
});

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

test('default dev gate keeps the historical p95 behavior and messages', () => {
  assert.deepEqual(renderGateFailures(goodMeasurement(), 180), []);
  assert.deepEqual(renderGateFailures(goodMeasurement({ p95FrameMs: 101 }), 180), ['Renderer p95 frame time exceeds 100 ms']);
  // p99, heap trend and boot timings stay opt-in for the dev profile.
  assert.deepEqual(renderGateFailures(goodMeasurement({ p99FrameMs: NaN, heapGrowthMb: 4096, readyMs: 60000, firstFrameMs: 60000 }), 180), []);
});

test('60hz profile enforces p95 and p99 frame budgets', () => {
  const options = { profile: '60hz' };
  assert.deepEqual(renderGateFailures(goodMeasurement({ p95FrameMs: 16.7, p99FrameMs: 33 }), 180, options), []);
  assert.deepEqual(renderGateFailures(goodMeasurement({ p95FrameMs: 16.8, p99FrameMs: 20 }), 180, options), ['Renderer p95 frame time exceeds 16.7 ms']);
  assert.deepEqual(renderGateFailures(goodMeasurement({ p95FrameMs: 10, p99FrameMs: 33.1 }), 180, options), ['Renderer p99 frame time exceeds 33 ms']);
});

test('60hz requires a finite p99 sample', () => {
  for (const p99FrameMs of [Number.NaN, undefined, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(renderGateFailures(goodMeasurement({ p95FrameMs: 10, p99FrameMs }), 180, { profile: '60hz' }), ['Renderer p99 frame time is not finite']);
  }
  // The dev profile deliberately ignores p99, so old evidence stays byte-compatible.
  assert.deepEqual(renderGateFailures(goodMeasurement({ p99FrameMs: Number.NaN }), 180), []);
});

test('heap growth fails only under a configured heap budget', () => {
  const growing = goodMeasurement({ heapGrowthMb: 40 });
  assert.deepEqual(renderGateFailures(growing, 180), []);
  assert.deepEqual(renderGateFailures(growing, 180, { profile: '60hz' }), ['Renderer heap growth exceeds 32 MB']);
  assert.deepEqual(renderGateFailures(goodMeasurement({ heapGrowthMb: 32 }), 180, { profile: '60hz' }), []);
  assert.deepEqual(renderGateFailures(goodMeasurement({ heapGrowthMb: 6 }), 180, { profile: '60hz' }), []);
  assert.deepEqual(renderGateFailures(goodMeasurement({ heapGrowthMb: 12 }), 180, { heapGrowthMb: 10 }), ['Renderer heap growth exceeds 10 MB']);
  // Dev/default configures no heap budget, so a missing heap metric is ignored (byte-compatible).
  assert.deepEqual(renderGateFailures(goodMeasurement({ heapGrowthMb: undefined }), 180), []);
});

test('configured heap budgets fail closed without a finite heap metric', () => {
  for (const heapGrowthMb of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.deepEqual(renderGateFailures(goodMeasurement({ heapGrowthMb }), 180, { profile: '60hz' }), ['Renderer heap growth is not finite']);
  }
  // Dev remains byte-compatible: no heap budget, no heap check.
  assert.deepEqual(renderGateFailures(goodMeasurement({ heapGrowthMb: undefined }), 180), []);
  // An explicit threshold opts a custom/dev run into the same fail-closed contract.
  assert.deepEqual(renderGateFailures(goodMeasurement({ heapGrowthMb: undefined }), 180, { profile: 'custom', heapGrowthMb: 10 }), ['Renderer heap growth is not finite']);
  assert.deepEqual(renderGateFailures(goodMeasurement({ heapGrowthMb: Number.NaN }), 180, { heapGrowthMb: 10 }), ['Renderer heap growth is not finite']);
});

test('profile failure ordering keeps p99, heap, boot, then GPU errors', () => {
  const bad = goodMeasurement({ p99FrameMs: Number.NaN, heapGrowthMb: undefined, gpuErrors: ['validation failed'] });
  assert.deepEqual(renderGateFailures(bad, 180, { profile: '60hz', readyMs: 1000, firstFrameMs: 1000 }), [
    'Renderer p99 frame time is not finite',
    'Renderer heap growth is not finite',
    'Renderer ready time exceeds 1000 ms',
    'Renderer first-frame time exceeds 1000 ms',
    'GPU or browser errors',
  ]);
});

test('custom profile honors explicit p95/p99 thresholds', () => {
  const options = { profile: 'custom', p95Ms: 20, p99Ms: 40 };
  assert.deepEqual(renderGateFailures(goodMeasurement({ p95FrameMs: 19, p99FrameMs: 39 }), 180, options), []);
  assert.deepEqual(renderGateFailures(goodMeasurement({ p95FrameMs: 21, p99FrameMs: 39 }), 180, options), ['Renderer p95 frame time exceeds 20 ms']);
  assert.deepEqual(renderGateFailures(goodMeasurement({ p95FrameMs: 19, p99FrameMs: 40.5 }), 180, options), ['Renderer p99 frame time exceeds 40 ms']);
});

test('readiness and first-frame thresholds are opt-in', () => {
  const timed = goodMeasurement({ readyMs: 900, firstFrameMs: 2500 });
  assert.deepEqual(renderGateFailures(timed, 180), []);
  assert.deepEqual(renderGateFailures(timed, 180, { readyMs: 1000, firstFrameMs: 3000 }), []);
  assert.deepEqual(renderGateFailures({ ...timed, readyMs: 1200 }, 180, { readyMs: 1000 }), ['Renderer ready time exceeds 1000 ms']);
  assert.deepEqual(renderGateFailures({ ...timed, firstFrameMs: 3500 }, 180, { firstFrameMs: 3000 }), ['Renderer first-frame time exceeds 3000 ms']);
  assert.deepEqual(renderGateFailures(goodMeasurement(), 180, { readyMs: 1000 }), ['Renderer ready time exceeds 1000 ms']);
});

test('maxFrames caps the required frame count', () => {
  const shorter = goodMeasurement({ measuredFrames: 100, rendererFrames: 100 });
  assert.deepEqual(renderGateFailures(shorter, 180), ['Insufficient actual renderer frames', 'Insufficient measured frames']);
  assert.deepEqual(renderGateFailures(shorter, 180, { maxFrames: 100 }), []);
});

test('profile thresholds resolve to documented defaults', () => {
  assert.deepEqual(resolveRenderGateThresholds(), { profile: 'dev', p95Ms: 100, p99Ms: null, heapGrowthMb: null, readyMs: null, firstFrameMs: null, maxFrames: null });
  assert.deepEqual(resolveRenderGateThresholds({ profile: '60hz' }), { profile: '60hz', p95Ms: 16.7, p99Ms: 33, heapGrowthMb: 32, readyMs: null, firstFrameMs: null, maxFrames: null });
  assert.deepEqual(resolveRenderGateThresholds({ profile: '60hz', p95Ms: 20 }), { profile: '60hz', p95Ms: 20, p99Ms: 33, heapGrowthMb: 32, readyMs: null, firstFrameMs: null, maxFrames: null });
  assert.throws(() => renderGateFailures(goodMeasurement(), 180, { profile: 'fast' }), /Unknown render gate profile/);
});
test('render_perf CLI rejects unknown profiles and bad thresholds before launching Chrome', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const script = path.join(root, 'tools/render_perf.mjs');
  const profile = spawnSync(process.execPath, [script, '--profile', 'turbo'], { cwd: root, encoding: 'utf8' });
  assert.equal(profile.status, 1);
  assert.match(profile.stderr, /Invalid --profile: turbo/);
  const threshold = spawnSync(process.execPath, [script, '--p95-ms', 'nope'], { cwd: root, encoding: 'utf8' });
  assert.equal(threshold.status, 1);
  assert.match(threshold.stderr, /Invalid --p95-ms: nope/);
});
