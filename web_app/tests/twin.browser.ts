// @ts-nocheck — real single-page UI regression with a connected-tab transport.
import assert from 'node:assert/strict';
export async function runTwinUiAcceptance(command, baseUrl = 'http://127.0.0.1:5173') {
async function evaluate(expression) {
  const result = await command('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails)
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
}
async function until(expression) {
  const end = Date.now() + 20000;
  while (Date.now() < end) {
    if (await evaluate(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const diagnostic = await evaluate("JSON.stringify({ url: location.href, bottom: document.querySelector('.twin-bottom')?.textContent ?? null, status: document.querySelector('.twin-status')?.getAttribute('title') ?? null, mode: document.querySelector('.twin-mode select')?.value ?? null })").catch(() => 'diagnostic unavailable');
  throw new Error(`Browser condition timed out: ${expression} | ${diagnostic}`);
}
async function pressEscape() {
  await command('Input.dispatchKeyEvent', {
    type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
  });
  await command('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
  });
}

  await command('Page.navigate', { url: baseUrl + '/' });
  await until(`!!document.querySelector('a[href="/twin"]')`);
  await evaluate(`localStorage.removeItem('semicon_twin_onboarding_dismissed')`);
  assert.equal(await evaluate(`!!document.querySelector('canvas')`), false, 'the website entrance must not render a preview');
  assert.equal(await evaluate(`!!document.querySelector('a[href="/preview"]')`), false);
  await command('Page.navigate', { url: baseUrl + '/twin?lang=zh-CN' });
  await until(`!!document.querySelector('.twin-page')`);
  await until(`document.querySelector('.twin-status')?.getAttribute('title')?.startsWith('WebGPU ·')`);
  // Source-exact AMHS controller must dispatch jobs and report active vehicles in the live HUD.
  await until(`!!document.querySelector('.twin-bottom')`);
  await until(`(() => { const text = document.querySelector('.twin-bottom')?.textContent ?? ''; const hit = text.indexOf('AMHS OHT '); return hit >= 0 && Number(text.slice(hit + 9, hit + 11)) > 0; })()`, 30000);
  // WebGPU holographic X-Ray: enable the shader path, cycle a utility filter and restore.
  await evaluate(`document.querySelector('#btn-toggle-xray').click()`);
  await until(`document.querySelector('#btn-toggle-xray').getAttribute('aria-pressed') === 'true' && !!document.querySelector('.twin-xray')`);
  await evaluate(`[...document.querySelectorAll('.twin-xray button')].find(button => button.textContent?.trim() === 'UPW')?.click()`);
  await until(`[...document.querySelectorAll('.twin-xray button')].some(button => button.className.includes('active') && button.textContent?.trim() === 'UPW')`);
  await evaluate(`document.querySelector('#btn-toggle-xray').click()`);
  await until(`document.querySelector('#btn-toggle-xray').getAttribute('aria-pressed') === 'false' && !document.querySelector('.twin-xray')`);
  assert.equal(await evaluate(`document.querySelectorAll('#left-sidebar').length`), 1);
  assert.equal(await evaluate(`document.querySelectorAll('.twin-levels button').length`), 4);
  assert.equal(await evaluate(`document.querySelectorAll('.twin-cameras button').length`), 5);
  assert.equal(await evaluate(`document.querySelectorAll('.twin-mode option').length`), 3);
  assert.equal(await evaluate(`document.querySelectorAll('#btn-focus-patrol').length`), 1);
  assert.equal(await evaluate(`document.querySelector('#header-yield-val')?.textContent?.includes('%')`), true);
  assert.ok((await evaluate(`document.querySelector('#header-wpm-val')?.textContent?.length`)) > 0);
  await evaluate(`document.querySelector('#btn-toggle-roof').click()`);
  await until(`document.querySelector('#btn-toggle-roof').getAttribute('aria-pressed') === 'true'`);
  await evaluate(`document.querySelector('#btn-toggle-roof').click()`);
  await until(`document.querySelector('#btn-toggle-roof').getAttribute('aria-pressed') === 'false'`);
  await evaluate(`document.querySelector('#btn-toggle-ceiling').click()`);
  await until(`document.querySelector('#btn-toggle-ceiling').getAttribute('aria-pressed') === 'true'`);
  await evaluate(`document.querySelector('#btn-toggle-ceiling').click()`);
  await until(`document.querySelector('#btn-toggle-ceiling').getAttribute('aria-pressed') === 'false'`);
  assert.equal(await evaluate(`document.querySelectorAll('#equipment-list [data-equipment-id]').length`), 18);

  await evaluate(`(() => { const select = document.querySelector('.twin-mode select'); select.value = 'visitor'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await until(`!document.querySelector('#left-sidebar')`);
  await evaluate(`(() => { const select = document.querySelector('.twin-mode select'); select.value = 'engineer'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await until(`!!document.querySelector('#left-sidebar')`);

  await evaluate(`document.querySelectorAll('.twin-levels button')[1].click()`);
  await until(`document.querySelectorAll('.twin-levels button')[1].getAttribute('class')?.includes('active')`);
  await evaluate(`document.querySelectorAll('.twin-levels button')[2].click()`);
  await until(`document.querySelectorAll('.twin-levels button')[2].getAttribute('class')?.includes('active')`);
  await evaluate(`document.querySelectorAll('.twin-levels button')[3].click()`);
  await until(`document.querySelectorAll('.twin-levels button')[3].getAttribute('class')?.includes('active')`);
  await until(`!!document.querySelector('.twin-explode input[type=range]')`);
  await evaluate(`(() => { const slider = document.querySelector('.twin-explode input[type=range]'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(slider, '40'); slider.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await until(`document.querySelector('.twin-explode b')?.textContent === '40%'`);
  await evaluate(`document.querySelectorAll('.twin-levels button')[0].click()`);
  await until(`document.querySelectorAll('.twin-levels button')[0].getAttribute('class')?.includes('active')`);

  await evaluate(`document.querySelector('#equipment-list [data-equipment-id]').click()`);
  await until(`!!document.querySelector('.twin-inspector')`);
  assert.match(await evaluate(`document.querySelector('.twin-inspector').innerText`), /FAB REFERENCE/);
  await until(`!!document.querySelector('.twin-mes') && !!document.querySelector('.twin-spc')`);
  assert.equal(await evaluate(`document.querySelectorAll('.twin-spc-sensors > div').length`), 4);
  assert.match(await evaluate(`document.querySelector('.twin-spc-grid').innerText`), /Cp[\s\S]*Cpk[\s\S]*SIGMA/);
  await evaluate(`Array.from(document.querySelectorAll('.twin-mes-actions button')).find((button) => button.textContent === 'Track-Out').click()`);
  await until(`document.querySelector('.twin-mes-state')?.textContent === 'TRACKED_OUT'`);
  await evaluate(`Array.from(document.querySelectorAll('.twin-mes-actions button')).find((button) => button.textContent === 'Hold').click()`);
  await until(`document.querySelector('.twin-mes-state')?.textContent === 'HOLD_MRB'`);
  await evaluate(`document.querySelector('.twin-inspector .twin-panel-title button[aria-label="关闭设备详情"]').click()`);
  await until(`!document.querySelector('.twin-inspector')`);

  await evaluate(`document.querySelector('.twin-yms-toggle').click()`);
  await until(`!!document.querySelector('.twin-yms')`);
  assert.equal(await evaluate(`document.querySelectorAll('.twin-patterns button').length`), 8);
  assert.ok((await evaluate(`document.querySelectorAll('.twin-wafer-stage rect').length`)) > 400);
  assert.match(await evaluate(`document.querySelector('.twin-yms-yield-row').innerText`), /GROSS YIELD/);
  assert.equal(await evaluate(`document.querySelectorAll('.twin-model-grid > div').length`), 3);
  await evaluate(`Array.from(document.querySelectorAll('.twin-yms-head nav button')).find((button) => button.textContent === 'Yield Waterfall').click()`);
  await until(`!!document.querySelector('.twin-yield-view')`);
  assert.equal(await evaluate(`document.querySelectorAll('.twin-yield-bars > div').length`), 8);
  assert.equal(await evaluate(`document.querySelectorAll('.twin-yield-scenarios button').length`), 7);
  await evaluate(`Array.from(document.querySelectorAll('.twin-yield-scenarios button')).find((button) => button.textContent === 'Etch Chamber RF Alarm').click()`);
  await until(`document.querySelector('.twin-yield-scenarios button.active')?.textContent === 'Etch Chamber RF Alarm'`);
  assert.match(await evaluate(`document.querySelector('.twin-yield-summary').innerText`), /OVERALL FAB YIELD/);
  await evaluate(`document.querySelector('.twin-yms-close').click()`);
  await until(`!document.querySelector('.twin-yms')`);

  if (await evaluate(`!!document.querySelector('.twin-onboarding')`)) {
    assert.match(await evaluate(`document.querySelector('.twin-onboarding').innerText`), /1\/3/);
    await evaluate(`document.querySelector('#onboarding-next-btn').click()`);
    await until(`document.querySelector('.twin-onboarding').innerText.includes('2/3')`);
    await evaluate(`document.querySelector('.twin-onboarding-head button').click()`);
    await until(`!document.querySelector('.twin-onboarding')`);
  }

  await evaluate(`(() => { const button = [...document.querySelectorAll('button')].find((item) => /Full Database|完整数据库/.test(item.textContent.trim())); button.focus(); button.click(); })()`);
  await until(`!!document.querySelector('#oem-database-modal')`);
  assert.equal(await evaluate(`document.querySelectorAll('#modal-database-tbody tr').length`), 116);
  assert.equal(await evaluate(`document.activeElement?.closest('#oem-database-modal') !== null`), true);
  await command('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
  await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
  assert.equal(await evaluate(`document.activeElement?.closest('#oem-database-modal') !== null`), true);
  await evaluate(`(() => { const select = document.querySelector('#modal-segment-select'); select.value = 'Lithography'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await until(`Number(document.querySelector('#modal-matched-count').textContent) < 116`);
  await pressEscape();
  await until(`!document.querySelector('#oem-database-modal')`);
  assert.match(await evaluate(`document.activeElement?.textContent ?? ''`), /Full Database|完整数据库/);
  await evaluate(`(() => { const button = [...document.querySelectorAll('button')].find((item) => /Open Arch|开放软件架构/.test(item.textContent.trim())); button.focus(); button.click(); })()`);
  await until(`!!document.querySelector('#open-architecture-modal')`);
  assert.equal(await evaluate(`document.querySelectorAll('.twin-arch-card').length`), 4);
  assert.equal(await evaluate(`document.querySelectorAll('#open-architecture-modal tbody tr').length`), 4);
  assert.equal(await evaluate(`document.querySelector('#open-architecture-modal')?.parentElement?.tagName`), 'BODY');
  await pressEscape();
  await until(`!document.querySelector('#open-architecture-modal')`);

  await evaluate(`document.querySelector('.twin-cut-toggle').click()`);
  await until(`!!document.querySelector('.twin-cut')`);
  assert.equal(await evaluate(`!!document.querySelector('#btn-cut-invert')`), true);
  await evaluate(`(() => { const slider = document.querySelector('.twin-cut input[type=range]'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(slider, '12'); slider.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await until(`document.querySelector('.twin-cut b')?.textContent === '12 m'`);
  await evaluate(`document.querySelector('.twin-cut select').value = 'Z'; document.querySelector('.twin-cut select').dispatchEvent(new Event('change', { bubbles: true }))`);
  await evaluate(`document.querySelector('.twin-cut-toggle').click()`);
  await until(`!document.querySelector('.twin-cut')`);
  await evaluate(`document.querySelectorAll('.twin-levels button')[0].click()`);
  await until(`document.querySelectorAll('.twin-levels button')[0].getAttribute('class')?.includes('active')`);

  await evaluate(`document.querySelector('#btn-toggle-xray').click()`);
  await until(`!!document.querySelector('.twin-xray')`);
  assert.equal(await evaluate(`document.querySelectorAll('.twin-xray button').length`), 7);
  await evaluate(`Array.from(document.querySelectorAll('.twin-xray button')).find((button) => button.textContent === 'UPW').click()`);
  await until(`document.querySelectorAll('.twin-levels button')[0].getAttribute('class')?.includes('active')`);
  await evaluate(`Array.from(document.querySelectorAll('.twin-xray button')).find((button) => button.textContent === '×').click()`);
  await until(`!document.querySelector('.twin-xray')`);

  await evaluate(`(() => { const select = document.querySelector('.twin-mode select'); select.value = 'research'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await until(`!!document.querySelector('.twin-research-hud')`);
  await until(`document.querySelector('.twin-research-head')?.innerText?.includes('27,263')`);
  assert.equal(await evaluate(`!!document.querySelector('#btn-toggle-util-overlay')`), true);
  await evaluate(`(() => { const slider = document.querySelector('.twin-research-scrubber'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; setter.call(slider, '1000000'); slider.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await until(`document.querySelectorAll('.twin-research-stats strong')[1]?.textContent === '84'`);
  assert.match(await evaluate(`document.querySelector('.twin-research-clock').innerText`), /Day 12/);
  assert.match(await evaluate(`document.querySelector('.twin-feed').innerText`), /REPLAY/);
  assert.equal(await evaluate(`!!document.querySelector('#left-sidebar')`), false);
  await evaluate(`(() => { const select = document.querySelector('.twin-mode select'); select.value = 'engineer'; select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await until(`!!document.querySelector('#left-sidebar')`);

  // This instance loses its original replay alias to packaging. A new replay
  // session must freeze the latest DEMO state, even at an unchanged replay time.
  await evaluate(`document.querySelectorAll('#equipment-list [data-equipment-id]')[2].click()`);
  await until(`!!document.querySelector('.twin-manual-state')`);
  await evaluate(`[...document.querySelectorAll('.twin-manual-state button')].find(b=>b.textContent==='MAINT').click()`);
  await until(`document.querySelector('.twin-manual-state button[aria-pressed="true"]')?.textContent==='MAINT'`);
  await evaluate(`(() => { const select=document.querySelector('.twin-mode select');select.value='research';select.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  await until(`!!document.querySelector('.twin-research-hud')`);
  assert.equal(await evaluate(`document.querySelector('.twin-manual-state button[aria-pressed="true"]')?.textContent`), 'MAINT');
  await evaluate(`(() => { const select=document.querySelector('.twin-mode select');select.value='engineer';select.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  await until(`!!document.querySelector('#left-sidebar')`);

  await evaluate(`document.querySelector('.twin-wafer-toggle').click()`);
  await until(`document.querySelector('.twin-wafer-row b')?.textContent?.includes('001 / 120')`);
  await evaluate(`document.querySelector('.twin-wafer-actions button').click()`);
  await new Promise((resolve) => setTimeout(resolve, 2300));
  await until(`document.querySelector('.twin-wafer-row b')?.textContent?.includes('002 / 120')`);
  await evaluate(`(() => { const select = document.querySelector('.twin-wafer-row select'); const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; setter.call(select, 'C'); select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await until(`document.querySelector('.twin-wafer-row b')?.textContent?.includes('/ 092')`);
  await evaluate(`document.querySelector('.twin-wafer-head button').click()`);
  await until(`!document.querySelector('.twin-wafer')`);

  await evaluate(`document.querySelector('.twin-tour').click()`);
  await until(`!!document.querySelector('.twin-tour-card')`);
  assert.equal(await evaluate(`document.querySelectorAll('.twin-tour-dots button').length`), 5);
  // Frozen tour dots are display-only; advance with the source next-waypoint button.
  for (let step = 0; step < 2; step += 1) {
    await evaluate(`[...document.querySelectorAll('.twin-tour-actions button')].find(button => button.textContent.includes('下一站'))?.click()`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await until(`document.querySelector('.twin-tour-head span')?.textContent?.includes('WAYPOINT 3/5')`);
  await evaluate(`document.querySelector('.twin-tour-head button').click()`);
  await until(`!document.querySelector('.twin-tour-card')`);

  await evaluate(`document.querySelector('#btn-toggle-laminar').click()`);
  await until(`document.querySelector('.twin-page').dataset.spatialMode === 'aerodynamics'`);
  await evaluate(`document.querySelector('#level-btn-exploded').click()`);
  await until(`!document.querySelector('.twin-aero-hud') && !!document.querySelector('.twin-explode')`);
  await evaluate(`document.querySelector('#btn-toggle-cut').click()`);
  await until(`!document.querySelector('.twin-explode') && !!document.querySelector('.twin-cut')`);
  await evaluate(`document.querySelector('#level-btn-l1').click()`);
  await until(`document.querySelector('.twin-page').dataset.spatialMode === 'none'`);
  await evaluate(`document.querySelector('#btn-cinematic-tour').click(); document.querySelector('#mode-select').focus()`);
  await pressEscape();
  await until(`!document.querySelector('.twin-tour-card')`);

  await evaluate(`document.querySelector('#lang-toggle-btn').click()`);
  await until(`document.documentElement.lang === 'en-US' && document.querySelector('.twin-brand').textContent.includes('Semiconductor')`);
  assert.equal(await evaluate(`localStorage.getItem('semiconfab_lang')`), 'en-US');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('#lang-toggle-btn')).fontSize`), '12px');
  assert.equal(await evaluate(`!![...document.querySelectorAll('button,label,option,dt,small')].find(e=>e.getClientRects().length && /[\\u3400-\\u9fff]/.test(e.textContent))`), false);
  await command('Page.navigate', { url: baseUrl + '/twin?mode=engineer' });
  await until(`document.documentElement.lang === 'en-US' && document.querySelector('#lang-toggle-btn')?.textContent === 'English'`);
  await until(`document.querySelector('.twin-status')?.getAttribute('title')?.startsWith('WebGPU ·')`);
  await evaluate(`(()=>{const input=document.querySelector('#search-input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'Lithography');input.dispatchEvent(new Event('input',{bubbles:true}))})()`);
  await until(`document.querySelectorAll('#equipment-list [data-equipment-id]').length > 0 && document.querySelectorAll('#equipment-list [data-equipment-id]').length < 18`);

  await command('Page.navigate', { url: baseUrl + '/twin?lang=en&modal=arch' });
  await until(`!!document.querySelector('#open-architecture-modal')`);
  assert.equal(await evaluate(`!!document.querySelector('.twin-onboarding')`), false);
  await pressEscape();
  await until(`!document.querySelector('#open-architecture-modal')`);
  await command('Page.navigate', { url: baseUrl + '/twin?lang=en&modal=yms' });
  await until(`!!document.querySelector('.twin-yms')`);
  await evaluate(`document.querySelector('.twin-yms-close').click()`);
  await until(`!document.querySelector('.twin-yms')`);
  return { controls: true, exclusiveModes: true, escapeWithFocusedControl: true, language: true, fontFloorPx: 12, singlePage: true };
}
