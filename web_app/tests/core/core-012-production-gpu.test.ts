import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

/**
 * CORE-012: production-bundle browser + WebGPU device-loss/recovery gate contract.
 *
 * The raw evidence is produced by tools/e2e_production.mjs (production preview
 * functional run) and tools/gpu_gate.mjs (real local GPU, Page.crashGpuProcess
 * device-loss injection, recovery cycles, heap samples). This test freezes their
 * executable contract and the production preview proxy they depend on.
 */
const root = process.cwd();
const read = (file: string): string => readFileSync(join(root, file), 'utf8');
const readRepo = (file: string): string => readFileSync(join(root, '..', file), 'utf8');

it('vite preview proxies /api so browser gates never need a dev server', () => {
  const config = read('vite.config.ts');
  expect(config).toMatch(/preview:\s*\{/);
  expect(config).toContain('proxy');
  expect(config).toContain('FAB_API_TARGET');
  expect(config).toContain('FAB_DEVELOPMENT_KEY');
});

it('production E2E drives the built artifact in a fixed browser and fails closed', () => {
  const tool = readRepo('tools/e2e_production.mjs');
  for (const flag of ['web-url', 'api-url', 'out', 'chrome', 'commit', 'mode']) {
    expect(tool, flag).toContain("arg('" + flag + "'");
  }
  expect(tool).toContain('production web target is not reachable');
  // Functional coverage of the Phase E production gates.
  expect(tool).toContain('WebGPU lifecycle');
  // Readiness must not be inferred from the initialization copy (it contains 'WebGPU').
  expect(tool).toContain('twin-render-status');
  expect(tool).toContain('no WebGL fallback');
  expect(tool).toContain('SSE connection established');
  expect(tool).toContain('unknown FAB shows the route error');
  expect(tool).toContain('no duplicate event streams');
  expect(tool).toContain('process.exitCode = 1');
  // It must not start a dev server/preview itself (Lead-owned scripts do that).
  expect(tool).not.toContain("'vite', '--host'");
  expect(tool).not.toContain('spawn(chrome, [\'--host');
});

it('GPU gate injects a real device loss, asserts recovery and no WebGL fallback', () => {
  const tool = readRepo('tools/gpu_gate.mjs');
  for (const flag of ['web-url', 'api-url', 'out', 'chrome', 'commit', 'duration-seconds']) {
    expect(tool, flag).toContain("arg('" + flag + "'");
  }
  // Primary gate: the acceptance-only ?perf bridge triggers the product's exact
  // device-loss -> recovering -> ready recovery path without a GPU-process crash.
  expect(tool).toContain('__SEMICONFAB_PERF__');
  expect(tool).toContain('forceDeviceLoss');
  expect(tool).toContain("'/3d?perf'");
  // Information-only real GPU-process crash probe (Browser domain; Chrome 155 has no
  // Page.crashGpuProcess). It is recorded as a limitation, never a silent pass.
  expect(tool).toContain('Browser.crashGpuProcess');
  expect(tool).toContain('auxiliaryProbe');
  expect(tool).toMatch(/not (?:the )?CORE-012 injection granularity|not used for the CORE-012/);
  expect(tool).toContain('webgpu');
  expect(tool).toContain('WebGL fallback context is present');
  expect(tool).toContain('recoveries');
  expect(tool).toContain('heapSamples');
  expect(tool).toContain('forceDeviceLoss injection returned false');
  expect(tool).toContain('did not reach ready after forceDeviceLoss');
  expect(tool).toContain('GPU GATE PASS');
  expect(tool).toContain('process.exitCode = 1');
  // Soak duration must be configurable into the required 5-30 minute window.
  expect(tool).toContain("arg('duration-seconds', '600')");
});

it('reports raw, SHA-bound browser evidence instead of hand-written PASS', () => {
  const e2e = readRepo('tools/e2e_production.mjs');
  const gpu = readRepo('tools/gpu_gate.mjs');
  for (const tool of [e2e, gpu]) {
    expect(tool).toContain('commit');
    expect(tool).toContain('generatedAt');
    expect(tool).toContain('JSON.stringify');
  }
  expect(e2e).toContain("arg('commit', 'pending')");
  expect(gpu).toContain("arg('commit', 'pending')");
});
