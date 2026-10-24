// @ts-nocheck — standalone CDP harness; page.evaluate payloads are untyped.
// Requires the local dev server and an isolated Chromium/Edge CDP port (9335).
// No browser automation dependency and no WebGPU hardware acceptance claim.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const tabs = await (await fetch('http://127.0.0.1:9335/json/list')).json();
const tab = tabs.find((value) => value.type === 'page');
assert.ok(tab, 'No isolated browser page');
const socket = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});
let sequence = 0;
const pending = new Map();
const runtimeErrors = [];
socket.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data));
  if (message.method === 'Runtime.exceptionThrown')
    runtimeErrors.push(message.params.exceptionDetails.text);
  if (!message.id) return;
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  clearTimeout(request.timer);
  if (message.error) request.reject(new Error(JSON.stringify(message.error)));
  else request.resolve(message.result);
});
function command(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP timeout: ${method}`));
    }, 15000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
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
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    if (await evaluate(expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Browser condition timed out: ${expression}`);
}
async function navigate(path) {
  await command('Page.navigate', { url: `http://127.0.0.1:5173${path}` });
  await until(`document.querySelector('.catalog-total strong')?.textContent === '253'`);
}

const badFile = fileURLToPath(
  new URL('../../.local/catalog-browser-invalid.json', import.meta.url),
);
try {
  await command('Page.enable');
  await command('Runtime.enable');
  await navigate('/catalog-demo.html?lang=en');
  assert.equal(await evaluate(`document.querySelectorAll('.catalog-list tbody tr').length`), 40);
  await evaluate(`document.querySelector('.catalog-hide-drafts input').click()`);
  await until(`document.querySelectorAll('.catalog-list tbody tr').length === 9`);
  await evaluate(`document.querySelector('.catalog-hide-drafts input').click()`);
  await until(`document.querySelectorAll('.catalog-list tbody tr').length === 40`);
  const gpuResources = await evaluate(
    `performance.getEntriesByType('resource').filter(entry => /babylon|gpu-/i.test(entry.name)).map(entry => entry.name)`,
  );
  assert.deepEqual(gpuResources, [], 'Read-only catalog must not load the Babylon/WebGPU renderer');
  await evaluate(`document.querySelector('input[type=search]').focus()`);
  await command('Input.insertText', { text: 'FPA-5550iZ2' });
  await until(
    `document.querySelectorAll('.catalog-list tbody tr').length === 1 && document.querySelector('.catalog-list tbody').textContent.includes('Canon')`,
  );
  await evaluate(`document.querySelector('.catalog-list tbody button').click()`);
  await until(
    `document.querySelector('dialog')?.open && document.querySelector('dialog').textContent.includes('vendor_confirmed')`,
  );
  await command('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
  });
  await command('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
  });
  await until(`!document.querySelector('dialog')`);
  await navigate('/catalog?domain=osat&lang=en');
  await until(`document.querySelector('.catalog-result-heading').textContent.includes('86 tools')`);
  for (let i = 0; i < 2; ++i)
    await evaluate(`document.querySelector('.catalog-pagination button:last-child').click()`);
  await until(`document.querySelectorAll('.catalog-list tbody tr').length === 6`);
  await evaluate(
    `Array.from(document.querySelectorAll('.catalog-list input[type=checkbox]')).slice(0,4).forEach(input => input.click())`,
  );
  await until(
    `document.querySelectorAll('.catalog-list input[type=checkbox]:checked').length === 4`,
  );
  assert.equal(
    await evaluate(
      `document.querySelectorAll('.catalog-list input[type=checkbox]:disabled').length`,
    ),
    2,
  );
  await evaluate(`document.querySelector('.catalog-filters > button').click()`);
  await until(
    `location.pathname === '/compare' && document.querySelectorAll('.catalog-comparison thead th').length === 5`,
  );
  assert.ok(
    (await evaluate(`document.querySelector('.catalog-comparison').textContent`)).includes(
      'Not available',
    ),
  );
  const pointer = JSON.parse(
    readFileSync(new URL('../../assets/legacy/current.json', import.meta.url), 'utf8'),
  );
  const rawCatalog = fileURLToPath(
    new URL(`../../assets/legacy/${pointer.importId}/raw/catalog.json`, import.meta.url),
  );
  async function selectFile(path) {
    const document = await command('DOM.getDocument');
    const input = await command('DOM.querySelector', {
      nodeId: document.root.nodeId,
      selector: 'input[type=file]',
    });
    await command('DOM.setFileInputFiles', { nodeId: input.nodeId, files: [path] });
  }
  await selectFile(rawCatalog);
  await until(`document.querySelector('.catalog-notice').textContent.includes('Local preview')`);
  writeFileSync(badFile, '[{"record_id":"invalid"}]');
  await selectFile(badFile);
  await until(`document.querySelector('[role=alert]') !== null`);
  assert.equal(
    await evaluate(`document.querySelector('.catalog-total strong').textContent`),
    '253',
  );
  assert.ok(
    (await evaluate(`document.querySelector('.catalog-notice').textContent`)).includes(
      'Local preview',
    ),
  );
  const theme = await evaluate(`document.querySelector('.catalog-shell').dataset.theme`);
  await evaluate(`document.querySelector('.catalog-preferences button:last-child').click()`);
  await until(
    `document.querySelector('.catalog-shell').dataset.theme !== ${JSON.stringify(theme)}`,
  );
  await navigate('/catalog?lang=en');
  const custom = JSON.parse(readFileSync(rawCatalog, 'utf8')).slice(0, 2);
  custom[0].vendor = 'LOCAL-VENDOR';
  custom[0].record.identity.vendor.value = 'LOCAL-VENDOR';
  custom[1].record_id = '11111111-1111-4111-8111-111111111111';
  custom[1].record.record_id = custom[1].record_id;
  custom[1].model = 'LOCAL-NEW';
  custom[1].record.identity.model.value = 'LOCAL-NEW';
  writeFileSync(badFile, JSON.stringify(custom));
  await selectFile(badFile);
  await until(`document.querySelector('.catalog-total strong').textContent === '2'`);
  await evaluate(
    `document.querySelectorAll('.catalog-list input[type=checkbox]').forEach(input => input.click())`,
  );
  await until(`document.querySelectorAll('.catalog-list input:checked').length === 2`);
  await evaluate(`document.querySelector('.catalog-filters > button').click()`);
  await until(
    `location.pathname === '/compare' && document.querySelector('h1')?.textContent.includes('compare') && document.querySelector('.catalog-total strong')?.textContent !== '0'`,
  );
  assert.equal(
    await evaluate(`document.querySelector('.catalog-total strong').textContent`),
    '2',
    'Comparison must retain local preview data',
  );
  await until(`document.querySelector('.catalog-comparison')?.textContent.includes('LOCAL-NEW')`);
  assert.ok(
    (await evaluate(`document.querySelector('.catalog-comparison').textContent`)).includes(
      'LOCAL-VENDOR',
    ),
  );
  await evaluate('history.back()');
  await until(`location.pathname === '/catalog' && document.querySelector('h1')?.textContent.includes('one tool')`);
  assert.equal(await evaluate(`document.querySelector('.catalog-total strong').textContent`), '2');
  await evaluate('history.forward()');
  await until(`location.pathname === '/compare' && document.querySelector('.catalog-comparison')?.textContent.includes('LOCAL-NEW')`);
  await command('Page.navigate', { url: 'http://127.0.0.1:5173/' });
  await until(`document.querySelectorAll('.fab-card').length >= 1`);
  await evaluate(`document.querySelector('button.primary').click()`);
  await until(`document.querySelector('.metrics .status')?.textContent.includes('已完成')`);
  assert.deepEqual(runtimeErrors, []);
  console.log(
    'Browser PASS: 253 records; hide-draft filter; no GPU module on catalog; live search; provenance modal/Escape; OSAT 86 + pagination; comparison limit/deep link; local import; failed import preserves data; preview comparison retains edited/new IDs across back/forward; theme; existing workbench Run completes; no runtime exceptions.',
  );
} finally {
  try {
    unlinkSync(badFile);
  } catch {}
  socket.close();
}
