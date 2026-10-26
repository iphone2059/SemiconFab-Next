// @ts-nocheck — exercise the committed Node capture tool without a browser transport.
import { expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateCapture, validateScenePixels } from '../../tools/frozen_visual_compare.mjs';

it('imports the visual comparison helpers without opening a CDP connection or writing captures', () => {
  const tool = new URL('../../tools/frozen_visual_compare.mjs', import.meta.url);
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    `const m = await import(${JSON.stringify(tool.href)}); if (typeof m.captureFrozenSite !== 'function') process.exit(2);`],
  { cwd: fileURLToPath(new URL('../../', import.meta.url)), encoding: 'utf8' });
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
});

it('rejects visual captures whose camera differs even when their virtual clocks match', () => {
  const expected = { position: [0, 52, 64], target: [0, 2, 0] };
  const capture = { status: 'WebGPU · 程序化 FAB · 121 台设备',
    viewport: { width: 1536, height: 735, dpr: 1 }, canvas: { width: 1536, height: 600, cssWidth: 1536, cssHeight: 600 }, pose: expected };
  expect(() => validateCapture(capture, expected)).not.toThrow();
  expect(() => validateCapture({ ...capture, pose: { position: [-7, 15, 36], target: [0, 2, 0] } }, expected)).toThrow(/camera/);
  expect(() => validateCapture({ ...capture, pose: null }, expected)).toThrow(/camera/);
  expect(() => validateCapture({ ...capture, pose: { ...expected, position: [NaN, 52, 64] } }, expected)).toThrow(/camera/);
});

it('rejects unready, zero-canvas and mismatched-viewport captures before measuring pixel differences', () => {
  const expected = { position: [0, 52, 64], target: [0, 2, 0] };
  const capture = { status: 'WebGPU · ready', viewport: { width: 1536, height: 735, dpr: 1 },
    canvas: { width: 1536, height: 600, cssWidth: 1536, cssHeight: 600 }, pose: expected };
  expect(() => validateCapture({ ...capture, status: 'initializing' }, expected)).toThrow(/ready/);
  expect(() => validateCapture({ ...capture, canvas: { width: 0, height: 600 } }, expected)).toThrow(/canvas/);
  expect(() => validateCapture({ ...capture, viewport: { width: 1280, height: 735, dpr: 1 } }, expected)).toThrow(/viewport/);
  expect(() => validateCapture({ ...capture, canvas: { width: 1, height: 1, cssWidth: 1536, cssHeight: 600 } }, expected)).toThrow(/canvas/);
});

it('rejects an empty scene ROI even when a ready HUD remains elsewhere in the screenshot', () => {
  const data = Buffer.alloc(12 * 12 * 3, 180);
  const image = { width: 12, height: 12, channels: 3, data };
  const roi = { x0: 2, y0: 2, x1: 10, y1: 10 };
  data[0] = 0; // HUD outside the scene must not make a blank scene pass.
  expect(() => validateScenePixels(image, roi)).toThrow(/blank/);
  for (let y = 2; y < 10; y++) for (let x = 2; x < 10; x++) {
    const offset = (y * 12 + x) * 3; data[offset] = x * 20; data[offset + 1] = y * 20;
  }
  expect(() => validateScenePixels(image, roi)).not.toThrow();
});
