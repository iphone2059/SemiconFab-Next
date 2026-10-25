// @ts-nocheck — production scene state and restore checks, using a supplied CDP transport.
import assert from 'node:assert/strict';
import { goldenEvaluate } from './twin-goldens.browser.ts';

export async function runLevelAcceptance(command, baseUrl = 'http://127.0.0.1:4173') {
  const evaluate = expression => goldenEvaluate(command, expression);
  await command('Page.navigate', { url: baseUrl + '/twin?lang=zh-CN&mode=engineer&perf=1' });
  for (let i = 0; i < 300; i++) {
    if (await evaluate("!!window.__SEMICONFAB_PERF__?.getScene()?.getMeshByName('subfab-floor')")) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await evaluate(`(() => {
    const scene = __SEMICONFAB_PERF__.getScene();
    window.__levelErrors = [];
    __SEMICONFAB_PERF__.getEngine()._device.addEventListener('uncapturederror', e => __levelErrors.push(e.error.message));
    window.__levelFrames = n => new Promise(resolve => { const frame = () => --n <= 0 ? resolve() : requestAnimationFrame(frame); requestAnimationFrame(frame); });
    window.__readLevel = () => ({
      equipment: scene.getTransformNodeByName('procedural-equipment').isEnabled(),
      personnel: scene.getTransformNodeByName('cleanroomPersonnel')?.isEnabled() ?? scene.getTransformNodeByName('procedural-personnel')?.isEnabled(),
      column: scene.getMeshByName('procedural-column-0').isEnabled(),
      ceiling: scene.getTransformNodeByName('ceilingFFU').isEnabled(),
      slab: scene.getMeshByName('procedural-slab').isEnabled(),
      floorAlpha: scene.getMaterialByName('procedural-floor-material').alpha,
      subfabFloor: scene.getMeshByName('subfab-floor').isEnabled(),
      subfabColor: scene.getMaterialByName('subfab-floor-material').albedoColor.toHexString(),
      tools: new Set(scene.meshes.filter(m => Number.isInteger(m.metadata?.toolIndex)).map(m => m.metadata.toolIndex)).size,
    });
  })()`);
  const result = {};
  for (const [level, alpha] of [['b1', 0.2], ['dual', 0.35], ['l1', 1]]) {
    await evaluate(`document.querySelector('#level-btn-${level}').click();__levelFrames(10)`);
    const state = await evaluate('__readLevel()');
    assert.equal(state.equipment, true, 'source retains L1 equipment in ' + level);
    assert.equal(state.column, true, 'source retains support columns in ' + level);
    assert.equal(state.slab, level === 'l1');
    assert.equal(state.floorAlpha, alpha);
    assert.equal(state.subfabFloor, level !== 'l1');
    assert.equal(state.tools, 121);
    assert.equal(state.subfabColor, '#1E293B');
    result[level] = state;
    await evaluate("document.querySelector('#btn-toggle-ceiling').click();__levelFrames(4)");
    assert.equal((await evaluate('__readLevel()')).ceiling, true, 'FFU enables directly in ' + level);
    await evaluate("document.querySelector('#btn-toggle-ceiling').click();__levelFrames(4)");
    assert.equal((await evaluate('__readLevel()')).ceiling, false);
  }
  await evaluate("document.querySelector('#btn-toggle-xray').click();__levelFrames(10)");
  assert.equal((await evaluate('__readLevel()')).slab, false, 'X-Ray must expose the piping through the slab');
  await evaluate("document.querySelector('#btn-toggle-xray').click();__levelFrames(10)");
  assert.deepEqual(await evaluate('__readLevel()'), result.l1, 'X-Ray restores complete L1 state');
  assert.deepEqual(await evaluate('__levelErrors'), []);
  return result;
}
