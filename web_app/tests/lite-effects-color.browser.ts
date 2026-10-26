// @ts-nocheck — isolated real-GPU test, transport supplied by the runner/connected tab.
import assert from 'node:assert/strict';
import { decodePng } from '../../tools/frozen_visual_compare.mjs';

async function sampleColor(command, url) {
    await command('Page.navigate', { url });
    const state = await command('Runtime.evaluate', {
      expression: `(async()=>{const end=Date.now()+20000;while(document.querySelector('output')?.textContent==='loading'&&Date.now()<end)await new Promise(r=>setTimeout(r,50));return {state:document.querySelector('output')?.textContent,errors:window.__COLOR_TEST__?.errors};})()`,
      returnByValue: true, awaitPromise: true,
    });
    assert.equal(state.result.value.state, 'ready');
    assert.equal(state.result.value.errors.length, 0);
    const shot = await command('Page.captureScreenshot', { format: 'png' });
    const image = decodePng(Buffer.from(shot.data, 'base64'));
    const offset = (128 * image.width + 128) * image.channels;
    return [...image.data.subarray(offset, offset + 3)];
}

/** Opaque source response only; translucent encoded-space compositing is measured separately. */
export async function runLiteEffectsColorAcceptance(command, baseUrl = 'http://127.0.0.1:5182') {
  const samples = {};
  for (const mode of ['direct', 'transmission']) {
    samples[mode] = await sampleColor(command, baseUrl + '/' + (mode === 'transmission' ? '?transmission=1' : ''));
  }
  assert.ok(samples.direct.every(v => v > 0 && v < 200), 'test surface rendered');
  // Frozen shader: tint*(.45+.2*.5), zero glow and no shadow => [.1375,.275,.4125].
  // LinearEncoding displays those values directly as [35,70,105], without a fitted lit multiplier.
  const sourceRgb = [35, 70, 105];
  assert.ok(samples.direct.every((value, index) => Math.abs(value - sourceRgb[index]) <= 2),
    `unshadowed X-Ray must preserve the frozen source response: ${JSON.stringify(samples.direct)}`);
  const maxChannelError = Math.max(...samples.direct.map((value, index) => Math.abs(value - samples.transmission[index])));
  assert.ok(maxChannelError <= 2, `transmission must preserve X-Ray display color: ${JSON.stringify(samples)}`);
  return { ...samples, maxChannelError };
}

/** Quantify the remaining alpha-compositing gap; a measurement is never a parity PASS. */
export async function runLiteEffectsGhostProbe(command, baseUrl = 'http://127.0.0.1:5182') {
  const backgrounds = {};
  for (const background of ['black', 'white']) {
    const url = baseUrl + '/?ghost=1' + (background === 'white' ? '&white=1' : '');
    const direct = await sampleColor(command, url);
    const transmission = await sampleColor(command, url + '&transmission=1');
    const maxChannelError = Math.max(...direct.map((value, index) => Math.abs(value - transmission[index])));
    backgrounds[background] = { direct, transmission, maxChannelError, parity: maxChannelError <= 2 };
  }
  return { status: Object.values(backgrounds).every(item => item.parity) ? 'PASS' : 'NOT_PARITY_VERIFIED', backgrounds };
}
